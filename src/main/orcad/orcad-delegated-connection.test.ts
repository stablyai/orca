import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD as CLAIM,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD as SUBSCRIBE,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD as ACK
} from '../../shared/pty-ownership-transfer-destination-claim'

vi.mock('./orcad-local-relay-connection', () => ({ connectOrcadLocalRelay: vi.fn() }))
let directory: string
const controllers: AbortController[] = []
beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'orca-delegated-connection-'))
})
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.abort()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(connectOrcadLocalRelay).mockReset()
  rmSync(directory, { recursive: true, force: true })
})

function setup(adapterIdentity = identity) {
  const store = new PtyOwnershipTransferDestinationFileStore({
    directory: join(directory, 'store')
  })
  const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
    directory: join(directory, 'outbox')
  })
  store.prepare(identity, 0)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: request(),
    endpoint: '/incumbent.sock',
    incumbentVersion: 'incumbent',
    endpointCredential: 'endpoint-secret'
  })
  outbox.open(identity, 0)
  const adapter = new PtyOwnershipTransferDestinationAdapter({
    store,
    publishDurably: (value) => value.publicationReceipt,
    publishPostCommitOutput: () => {
      throw new Error('unexpected committed output')
    }
  })
  adapter.prepare({
    ...adapterIdentity,
    version: 1,
    phase: 'prepared',
    sourceOutputEndSeq: 0,
    replayStartSeq: 1,
    surfacePublication: preparation.surfacePublication
  })
  adapter.bindSurface(preparation.surfacePublication.surfaceBinding)
  const controller = new AbortController()
  controllers.push(controller)
  const listeners = new Set<(reason: string) => void>()
  const notifications = new Map<string, (params: Record<string, unknown>) => void>()
  const removeNotification = vi.fn((method: string) => {
    notifications.delete(method)
  })
  const response = (method: string, params?: Record<string, unknown>) => {
    const base = { ...identity, version: 1 }
    switch (method) {
      case STATUS:
        return { ...base, phase: 'prepared', destinationClaim: null, boundToConnection: false }
      case CLAIM:
        return {
          ...base,
          destinationGeneration: params?.destinationGeneration,
          claimId: params?.claimId
        }
      case SUBSCRIBE:
        return { ...base, subscribed: true, afterSeq: params?.afterSeq, executionNotifications: 1 }
      case ACK:
        return { ...base, acknowledgedThroughSeq: params?.afterSeq }
      default:
        throw new Error(`unexpected method: ${method}`)
    }
  }
  const rpc = vi.fn<SshChannelMultiplexer['request']>(async (method, params) =>
    response(method, params)
  )
  const dispose = vi.fn()
  const multiplexer = {
    request: rpc,
    dispose,
    onDispose: (listener: (reason: string) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onNotificationByMethod: (
      method: string,
      listener: (params: Record<string, unknown>) => void
    ) => {
      notifications.set(method, listener)
      return () => removeNotification(method)
    }
  } as unknown as SshChannelMultiplexer
  vi.mocked(connectOrcadLocalRelay).mockImplementation(async (options) => {
    options.initialize?.(multiplexer)
    return multiplexer
  })
  const onError = vi.fn()
  const connect = (overrides: Partial<Parameters<typeof connectOrcadDelegatedTransfer>[0]> = {}) =>
    connectOrcadDelegatedTransfer({
      identity,
      store,
      outbox,
      adapter,
      signal: controller.signal,
      onError,
      createClaimId: () => 'claim-1',
      ...overrides
    })
  const emit = () =>
    notifications.get('pty.ownershipTransfer.destinationOutput')?.({
      ...identity,
      version: 1,
      destinationClaim: { generation: 1, claimId: 'claim-1' },
      frame: { seq: 1, data: 'coalesced' }
    })
  return {
    store,
    outbox,
    adapter,
    controller,
    rpc,
    response,
    dispose,
    multiplexer,
    listeners,
    removeNotification,
    onError,
    connect,
    emit,
    remoteDispose: () => {
      for (const listener of listeners) {
        listener('connection_lost')
      }
    },
    hasReceiver: () => notifications.has('pty.ownershipTransfer.destinationOutput')
  }
}

it('does not connect when the prepared adapter belongs to another transfer', async () => {
  const fixture = setup({ ...identity, bridgeId: 'other-bridge' })
  await expect(fixture.connect()).rejects.toThrow('destination_unavailable')
  expect(connectOrcadLocalRelay).not.toHaveBeenCalled()
})

it('waits for saved-model initialization before contacting the source', async () => {
  const f = setup()
  let finish!: () => void
  const initializeModel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const pending = f.connect({ initializeModel })
  expect(initializeModel).toHaveBeenCalledWith(f.controller.signal)
  expect(connectOrcadLocalRelay).not.toHaveBeenCalled()
  finish()
  const connection = await pending
  expect(connectOrcadLocalRelay).toHaveBeenCalledOnce()
  await connection.dispose()
})

it('cannot contact the source after disposal interrupts model initialization', async () => {
  const f = setup()
  let finish!: () => void
  const pending = f.connect({
    initializeModel: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  })
  f.controller.abort()
  finish()
  await expect(pending).rejects.toThrow('stale')
  expect(connectOrcadLocalRelay).not.toHaveBeenCalled()
})

it('does not contact the source when model restore fails', async () => {
  const f = setup()
  await expect(
    f.connect({
      initializeModel: async () => {
        throw new Error('restore failed')
      }
    })
  ).rejects.toThrow('restore failed')
  expect(connectOrcadLocalRelay).not.toHaveBeenCalled()
})

it('cleans up an initialized connection when startup fails', async () => {
  const fixture = setup()
  vi.mocked(connectOrcadLocalRelay).mockImplementationOnce(async (options) => {
    options.initialize?.(fixture.multiplexer)
    throw new Error('handshake failed')
  })
  await expect(fixture.connect()).rejects.toThrow('handshake failed')
  expect(fixture.dispose).toHaveBeenCalledOnce()
  expect(fixture.listeners.size).toBe(0)
  expect(fixture.rpc).not.toHaveBeenCalled()
})

it.each(['abort', 'remote'] as const)(
  'fences %s disposal after initialization before handshake returns',
  async (mode) => {
    const fixture = setup()
    let settle!: () => void
    vi.mocked(connectOrcadLocalRelay).mockImplementationOnce((options) => {
      options.initialize(fixture.multiplexer)
      return new Promise((resolve) => {
        settle = () => resolve(fixture.multiplexer)
      })
    })
    const pending = fixture.connect()
    if (mode === 'abort') {
      fixture.controller.abort()
    } else {
      fixture.remoteDispose()
    }
    settle()
    await expect(pending).rejects.toThrow('stale')
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.listeners.size).toBe(0)
    expect(fixture.rpc).not.toHaveBeenCalled()
  }
)

it.each([STATUS, CLAIM, SUBSCRIBE])(
  'fences abort during %s and ignores its late reply',
  async (blockedMethod) => {
    const fixture = setup()
    let settle!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    fixture.rpc.mockImplementation(async (method, params) => {
      if (method === blockedMethod) {
        entered()
        return new Promise((resolve) => {
          settle = () => resolve(fixture.response(method, params))
        })
      }
      return fixture.response(method, params)
    })
    const pending = fixture.connect()
    await waiting
    fixture.controller.abort()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    const requestCount = fixture.rpc.mock.calls.length
    settle()
    await expect(pending).rejects.toThrow('stale')
    fixture.emit()
    await vi.runAllTimersAsync()
    expect(fixture.rpc).toHaveBeenCalledTimes(requestCount)
    expect(fixture.outbox.load(identity)?.acceptedEndSeq).toBe(0)
    expect(fixture.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it.each([{ terminalId: 'other' }, { version: 2 }, { subscribed: false }, { afterSeq: 1 }])(
  'rejects a mismatched subscription and removes its receiver: %j',
  async (patch) => {
    const fixture = setup()
    fixture.rpc.mockImplementation(async (method, params) => ({
      ...fixture.response(method, params),
      ...(method === SUBSCRIBE ? patch : {})
    }))
    await expect(fixture.connect()).rejects.toThrow('subscription_invalid')
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.removeNotification).toHaveBeenCalledTimes(2)
    expect(fixture.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('installs the receiver before subscription can deliver coalesced output', async () => {
  const fixture = setup()
  fixture.rpc.mockImplementation(async (method, params) => {
    if (method === SUBSCRIBE) {
      expect(fixture.hasReceiver()).toBe(true)
      fixture.emit()
      expect(fixture.outbox.load(identity)?.acceptedEndSeq).toBe(1)
    }
    return fixture.response(method, params)
  })
  const connection = await fixture.connect()
  await vi.runAllTimersAsync()
  expect(fixture.store.loadFrames(identity)).toEqual([{ seq: 1, data: 'coalesced' }])
  expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(1)
  expect(fixture.onError).not.toHaveBeenCalled()
  expect(connection.isActive()).toBe(true)
  connection.dispose()
})

it('remote disposal fences clients and cancels pending replay delivery', async () => {
  const fixture = setup()
  const connection = await fixture.connect()
  fixture.emit()
  expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
  fixture.remoteDispose()
  expect(connection.isActive()).toBe(false)
  const requestCount = fixture.rpc.mock.calls.length
  await expect(connection.client.status(request())).rejects.toThrow('stale')
  fixture.emit()
  await vi.runAllTimersAsync()
  expect(fixture.store.loadFrames(identity)).toEqual([])
  expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
  expect(fixture.rpc).toHaveBeenCalledTimes(requestCount)
  expect(fixture.removeNotification).toHaveBeenCalledTimes(2)
  expect(fixture.listeners.size).toBe(0)
  connection.dispose()
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it('replays from the source ACK when the destination saved output before disconnect', async () => {
  const fixture = setup()
  fixture.outbox.enqueue(identity, { seq: 1, data: 'coalesced' })
  fixture.rpc.mockImplementation(async (method, params) => {
    if (method === STATUS) {
      return {
        ...fixture.response(method, params),
        sourceOutputEndSeq: 1,
        destinationAcknowledgedSeq: 0
      }
    }
    if (method === SUBSCRIBE) {
      expect(params?.afterSeq).toBe(0)
      fixture.emit()
    }
    return fixture.response(method, params)
  })
  const connection = await fixture.connect()
  await vi.runAllTimersAsync()
  expect(connection.proof.afterSeq).toBe(0)
  expect(fixture.store.loadFrames(identity)).toEqual([{ seq: 1, data: 'coalesced' }])
  expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(1)
  expect(fixture.onError).not.toHaveBeenCalled()
  connection.dispose()
})

it('refuses a source ACK beyond the durable destination cursor', async () => {
  const fixture = setup()
  fixture.rpc.mockImplementation(async (method, params) => ({
    ...fixture.response(method, params),
    ...(method === STATUS ? { sourceOutputEndSeq: 1, destinationAcknowledgedSeq: 1 } : {})
  }))
  await expect(fixture.connect()).rejects.toThrow('output_cursor_conflict')
  expect(fixture.rpc.mock.calls.some(([method]) => method === SUBSCRIBE)).toBe(false)
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it('fences provider input immediately but waits for its pending lane during disposal', async () => {
  const fixture = setup()
  const connection = await fixture.connect()
  let complete!: () => void
  vi.spyOn(connection.providerInput, 'whenIdle').mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve
    })
  )
  const settled = vi.fn()
  const stopping = connection.dispose()!.then(settled)
  expect(connection.providerInput.write(identity.terminalId, 'must not run')).toBe(false)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  complete()
  await stopping
  expect(settled).toHaveBeenCalledOnce()
})
