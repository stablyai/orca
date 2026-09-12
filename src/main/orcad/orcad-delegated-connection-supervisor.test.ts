import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { OrcadLocalRelayUnavailableError } from './orcad-local-relay-unavailable'

vi.mock('./orcad-delegated-connection', () => ({ connectOrcadDelegatedTransfer: vi.fn() }))
type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
type Destination = Parameters<OrcadDelegatedConnectionSupervisor['track']>[0]
const supervisors: OrcadDelegatedConnectionSupervisor[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(connectOrcadDelegatedTransfer).mockReset()
})
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  vi.useRealTimers()
})

function setup(retryAfterBudget?: (error: unknown) => boolean) {
  const controller = new AbortController()
  const onError = vi.fn()
  const supervisor = new OrcadDelegatedConnectionSupervisor({
    signal: controller.signal,
    onError,
    retryAfterBudget
  })
  supervisors.push(supervisor)
  const destination = {
    identity: { ...identity },
    adapter: {},
    store: {},
    outbox: {}
  } as Destination
  return { supervisor, controller, onError, destination }
}

function connection(signal?: AbortSignal, settled = Promise.resolve()) {
  let active = true
  const listeners = new Set<() => void>()
  const dispose = vi.fn(() => {
    if (!active) {
      return settled
    }
    active = false
    signal?.removeEventListener('abort', dispose)
    for (const listener of listeners) {
      listener()
    }
    return settled
  })
  signal?.addEventListener('abort', dispose, { once: true })
  const result = {
    isActive: () => active,
    dispose,
    multiplexer: {
      onDispose: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  } as unknown as Connection
  return { result, dispose, listeners }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

it('coalesces repeated discovery into one connection and snapshots identity', async () => {
  const { supervisor, destination } = setup()
  const connected = connection()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connected.result)
  supervisor.track(destination)
  supervisor.track(destination)
  destination.identity.terminalId = 'mutated'
  await flush()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].identity).toEqual(identity)
  expect(supervisor.getConnection(identity)).toBe(connected.result)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles the current recovery attempt only after installing its provider', async () => {
  const bindConnection = vi.fn(() => () => {})
  const supervisor = new OrcadDelegatedConnectionSupervisor({
    signal: new AbortController().signal,
    onError: vi.fn(),
    bindConnection
  })
  supervisors.push(supervisor)
  let resolve!: (value: Connection) => void
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  supervisor.track(setup().destination)
  const settled = vi.fn()
  const pending = supervisor.settlePendingConnections().then(settled)
  await flush()
  expect(settled).not.toHaveBeenCalled()
  expect(bindConnection).not.toHaveBeenCalled()
  resolve(connection().result)
  await pending
  expect(bindConnection).toHaveBeenCalledOnce()
  expect(settled).toHaveBeenCalledOnce()
})

it('does not turn failed initial recovery into liveness or wait for scheduled retries', async () => {
  const { supervisor, destination, onError } = setup()
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(new Error('source unavailable'))
  supervisor.track(destination)
  await supervisor.settlePendingConnections()
  expect(onError).toHaveBeenCalledOnce()
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
})

it.each(['identity', 'adapter', 'store', 'outbox', 'providerModel'] as const)(
  'refuses a competing %s for an already tracked bridge',
  async (field) => {
    const { supervisor, destination } = setup()
    vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connection().result)
    supervisor.track(destination)
    const conflict = {
      ...destination,
      [field]: field === 'identity' ? { ...identity, incarnationId: 'other' } : {}
    }
    expect(() => supervisor.track(conflict)).toThrow('destination_conflict')
    await flush()
    expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  }
)

it('refuses replacing a tracked exit consumer', async () => {
  const { supervisor, destination } = setup()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connection().result)
  const onExit = vi.fn()
  supervisor.track({ ...destination, onExit })
  supervisor.track({ ...destination, onExit })
  expect(() => supervisor.track({ ...destination, onExit: vi.fn() })).toThrow(
    'destination_conflict'
  )
  await flush()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
})

it('fences the old lifetime before reconnecting after transport loss', async () => {
  const { supervisor, destination } = setup()
  const connections: ReturnType<typeof connection>[] = []
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async ({ signal }) => {
    const next = connection(signal)
    connections.push(next)
    return next.result
  })
  supervisor.track(destination)
  await flush()
  connections[0].dispose()
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].signal.aborted).toBe(true)
  expect(connections[0].listeners.size).toBe(0)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(999)
  expect(connections).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(connections).toHaveLength(2)
  expect(supervisor.getConnection(identity)).toBe(connections[1].result)
})

it('bounds retries even when failures flap through successful connections', async () => {
  const { supervisor, destination } = setup()
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async () => connection().result)
  supervisor.track(destination)
  await flush()
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
    supervisor.getConnection(identity)!.dispose()
    await vi.advanceTimersByTimeAsync(delay)
  }
  supervisor.getConnection(identity)!.dispose()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(7)
  expect(vi.getTimerCount()).toBe(0)
  supervisor.retry(identity)
  await flush()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(8)
})

it('keeps failures fenced after exhausting retries, even if diagnostics throw', async () => {
  const { supervisor, destination, onError } = setup()
  onError.mockImplementation(() => {
    throw new Error('logger failed')
  })
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(new Error('source recovery required'))
  supervisor.track(destination)
  await vi.runAllTimersAsync()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(7)
  expect(onError).toHaveBeenCalledTimes(7)
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps retrying classified outages at the capped delay and stops for evidence refusal', async () => {
  const { supervisor, destination } = setup(
    (error) => error instanceof OrcadLocalRelayUnavailableError
  )
  const offline = new OrcadLocalRelayUnavailableError(new Error('connection refused'))
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(offline)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(121_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(9)
  expect(supervisor.getConnectionError(identity)).toBe(offline)
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(vi.getTimerCount()).toBe(1)
  const refused = new Error('claim conflict')
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(refused)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(supervisor.getConnectionError(identity)).toBe(refused)
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for in-flight startup and disposes a late successful connection on stop', async () => {
  const { supervisor, destination } = setup()
  let resolve!: (connection: Connection) => void
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  supervisor.track(destination)
  await flush()
  supervisor.retry(identity)
  const stopping = supervisor.stop()
  expect(supervisor.stop()).toBe(stopping)
  expect(vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].signal.aborted).toBe(true)
  let settled = false
  void stopping.then(() => {
    settled = true
  })
  await flush()
  expect(settled).toBe(false)
  const late = connection()
  resolve(late.result)
  await stopping
  expect(late.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(() => supervisor.track(destination)).toThrow('supervisor_stopped')
})

it('aborting the daemon lifetime clears reconnect timers and live connections', async () => {
  const { supervisor, destination, controller } = setup()
  const connections: ReturnType<typeof connection>[] = []
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async ({ signal }) => {
    const next = connection(signal)
    connections.push(next)
    return next.result
  })
  supervisor.track(destination)
  supervisor.track({ ...destination, identity: { ...identity, bridgeId: 'second' } })
  await flush()
  connections[0].dispose()
  expect(vi.getTimerCount()).toBe(1)
  controller.abort()
  await supervisor.stop()
  expect(connections.every(({ result }) => !result.isActive())).toBe(true)
  expect(connections.every(({ listeners }) => listeners.size === 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not connect when the daemon lifetime was already aborted', async () => {
  const { supervisor, destination, controller } = setup()
  controller.abort()
  expect(() => supervisor.track(destination)).toThrow('supervisor_stopped')
  const aborted = new OrcadDelegatedConnectionSupervisor({
    signal: controller.signal,
    onError: vi.fn()
  })
  supervisors.push(aborted)
  expect(() => aborted.track(destination)).toThrow('supervisor_stopped')
  await flush()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('waits for pending model cleanup before replacing a disconnected connection', async () => {
  const { supervisor, destination } = setup()
  let finish!: () => void
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const previous = connection(undefined, settled)
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValueOnce(previous.result)
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connection().result)
  supervisor.track(destination)
  await flush()
  previous.dispose()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  finish()
  await flush()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(2)
})

it('keeps shutdown pending until an active model write has settled', async () => {
  const { supervisor, destination } = setup()
  let finish!: () => void
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connection(undefined, settled).result)
  supervisor.track(destination)
  await flush()
  const stopped = vi.fn()
  const stopping = supervisor.stop().then(stopped)
  await flush()
  expect(stopped).not.toHaveBeenCalled()
  finish()
  await stopping
  expect(stopped).toHaveBeenCalledOnce()
})

it('retries a connection lost before its disposal hook could be installed', async () => {
  const { supervisor, destination } = setup()
  const closed = connection()
  closed.dispose()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValueOnce(closed.result)
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(connection().result)
  supervisor.track(destination)
  await flush()
  expect(supervisor.getConnection(identity)).toBeNull()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(2)
})
