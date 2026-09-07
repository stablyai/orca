import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type RequestContext,
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

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function responseResult(buffer: Buffer): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return message.id === undefined ? null : (message.result ?? null)
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('PTY source activation from a superseded owner', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  async function createHarness() {
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
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    return { adapter, publication, writes }
  }

  function contextFor(
    clientId: number,
    settlements: ((result: SinkWriteSettlement) => void)[]
  ): RequestContext {
    return {
      clientId,
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (callback) => settlements.push(callback)
    }
  }

  /**
   * The superseded transport must not release, cancel or retire the delivery its own replacement
   * opened: releasing the fence resumes a send the replacement is still rotating, and retiring it
   * blanks the pane that owns it.
   */
  it('leaves the replacement delivery intact when the superseded owner re-activates', async () => {
    const { publication, adapter, writes } = await createHarness()
    const settlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(publication.activate('pty-1', 'incarnation-1', contextFor(1, settlements))).toBe(
      'opened'
    )
    settlements[0]({ ok: true })
    const activation = publication.receivingActivation('pty-1', 1)!
    const ownerGrant = writes.map(responseResult).find((result) => result?.ownerLease)!

    // The original transport arms its rotation fence while waiting for a checkpoint-safe send.
    await expect(publication.waitForPendingSend('pty-1')).resolves.toBe(true)

    const replacementWrites: Buffer[] = []
    const replacementClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        replacementWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      replacementClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: ownerGrant.ownerGeneration,
          ownerLease: ownerGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()

    const replacementSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const recovery = {
      status: 'checkpoint' as const,
      clientGeneration: activation.clientGeneration,
      ownerGeneration: activation.ownerGeneration,
      ptyIncarnation: activation.ptyIncarnation,
      deliveryToken: activation.deliveryToken,
      acceptedSourceEndSu: 0
    }
    expect(
      publication.activate(
        'pty-1',
        'incarnation-1',
        contextFor(replacementClientId, replacementSettlements),
        recovery
      )
    ).toMatchObject({ status: 'pending' })
    replacementSettlements[0]({ ok: true })

    // Arm the replacement fence, then let the superseded transport's activation resume. isStale()
    // stays false on purpose: the superseded client is still attached, so production reaches the
    // delivery-mode bail-outs rather than any stale early-out.
    await expect(publication.waitForPendingSend('pty-1')).resolves.toBe(true)
    const cancelDelivery = vi.spyOn(adapter, 'cancelDelivery')
    expect(publication.activate('pty-1', 'incarnation-1', contextFor(1, []), recovery)).toBe(false)
    expect(cancelDelivery).not.toHaveBeenCalled()
    expect(publication.publish('pty-1', { data: 'replacement-output' }, false)).toBe(false)

    // Release the replacement fence through its owning transport so no parked work is left behind.
    expect(
      publication.activate('pty-1', 'incarnation-1', contextFor(replacementClientId, []))
    ).toBe('existing')
    expect(replacementWrites.length).toBeGreaterThan(0)
  })
})
