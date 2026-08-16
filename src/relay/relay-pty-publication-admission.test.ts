import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type RelayClientSinkOptions,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

type RpcMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

function message(buffer: Buffer): RpcMessage | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
}

function openFrame(
  id: number,
  requestedRole: 'session-owner' | 'subscriber',
  outputFlowControl = false
): Buffer {
  return encodeJsonRpcFrame(
    {
      jsonrpc: '2.0',
      id,
      method: 'pty.openClient',
      params: {
        protocolVersion: 1,
        clientInstanceId: `client-${id}`,
        requestedRole,
        ...(outputFlowControl
          ? {
              capabilities: {
                outputFlowControl: { versions: [1], requestedWindowSu: 16 }
              }
            }
          : {})
      }
    },
    id,
    0
  )
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

class SaturatedSink {
  readonly writes: Buffer[] = []
  private readonly drainWaiters = new Set<() => void>()
  private writableBytes = 0
  saturateNext = false

  readonly options: RelayClientSinkOptions = {
    supportsWriteCallback: true,
    writableLength: () => this.writableBytes,
    writableHighWaterMark: () => 8 * 1024 * 1024,
    waitWriteDrain: (callback) => {
      this.drainWaiters.add(callback)
      return () => this.drainWaiters.delete(callback)
    }
  }

  write = (data: Buffer, onSettled: (result: SinkWriteSettlement) => void): boolean => {
    this.writes.push(Buffer.from(data))
    this.writableBytes += data.length
    onSettled({ ok: true })
    if (!this.saturateNext) {
      return true
    }
    this.saturateNext = false
    return false
  }

  drain(): void {
    this.writableBytes = 0
    for (const callback of Array.from(this.drainWaiters)) {
      callback()
    }
  }
}

describe('relay PTY publication admission', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('retires queued legacy data when the source-credit grant response overtakes it', async () => {
    const sink = new SaturatedSink()
    dispatcher = new RelayDispatcher(sink.write, sink.options, endpointIdentity)
    sink.saturateNext = true
    dispatcher.notify('test.blocker')
    const settled = vi.fn<(result: SinkWriteSettlement) => void>()
    const legacyData = 'x'.repeat(1024 * 1024 + 128)

    expect(dispatcher.tryNotifyPtyDataToClient(1, { id: 'pty-1', data: legacyData }, settled)).toBe(
      true
    )
    expect(dispatcher.legacyRetentionBelowLowWater).toBe(false)
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    expect(adapter.deliveryMode(1)).toBe('unadmitted')
    dispatcher.feed(openFrame(1, 'session-owner', true))
    await flushRequests()

    sink.drain()

    expect(sink.writes.map(message).some((entry) => entry?.method === 'pty.data')).toBe(false)
    expect(sink.writes.map(message).find((entry) => entry?.id === 1)?.result).toMatchObject({
      role: 'session-owner'
    })
    expect(settled).toHaveBeenCalledOnce()
    expect(settled.mock.calls[0][0]).toMatchObject({ ok: false })
    expect(dispatcher.legacyRetentionBelowLowWater).toBe(true)
  })

  it('does not publish legacy data to a source-credit owner before PTY attachment', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(openFrame(1, 'session-owner', true))
    await flushRequests()

    expect(adapter.deliveryMode(1)).toBe('source-owner')
    expect(dispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'legacy' })).toBe(true)

    expect(writes.map(message).filter((entry) => entry?.method === 'pty.data')).toEqual([])
  })

  it('publishes current source output to the admitted source-credit owner', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    const publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(openFrame(1, 'session-owner', true))
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []

    expect(
      publication.activate('pty-1', 'incarnation-1', {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => activationSettlements.push(callback)
      })
    ).toBe('opened')
    activationSettlements[0]({ ok: true })
    expect(publication.publish('pty-1', { data: 'current' }, false)).toBe(true)

    const data = writes.map(message).find((entry) => entry?.method === 'pty.data')?.params
    expect(data).toMatchObject({
      id: 'pty-1',
      data: 'current',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-1'
    })
    expect(data?.deliveryToken).toEqual(expect.any(String))
  })

  it('publishes legacy output to an admitted subscriber', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(openFrame(1, 'subscriber'))
    await flushRequests()

    expect(adapter.deliveryMode(1)).toBe('subscriber')
    expect(dispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'legacy' })).toBe(true)

    expect(writes.map(message).find((entry) => entry?.method === 'pty.data')?.params).toMatchObject(
      { id: 'pty-1', data: 'legacy' }
    )
  })
})
