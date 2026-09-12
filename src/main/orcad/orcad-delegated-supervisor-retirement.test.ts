import { afterEach, expect, it, vi } from 'vitest'
import { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { OrcadDelegatedProviderExits } from './orcad-delegated-provider-exits'
import type { OrcadDelegatedExitEvent } from './orcad-delegated-exit-delivery'

vi.mock('./orcad-delegated-connection', () => ({ connectOrcadDelegatedTransfer: vi.fn() }))
type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
type Destination = Parameters<OrcadDelegatedConnectionSupervisor['track']>[0]
const supervisors: OrcadDelegatedConnectionSupervisor[] = []
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  vi.useRealTimers()
  vi.resetAllMocks()
})

function setup(
  recoverRetirement?: ConstructorParameters<
    typeof OrcadDelegatedConnectionSupervisor
  >[0]['recoverRetirement']
) {
  vi.useFakeTimers()
  const removeBinding = vi.fn()
  const bindConnection = vi.fn(() => removeBinding)
  const supervisor = new OrcadDelegatedConnectionSupervisor({
    signal: new AbortController().signal,
    onError: vi.fn(),
    recoverRetirement,
    bindConnection
  })
  supervisors.push(supervisor)
  const destination = { identity, adapter: {}, store: {}, outbox: {} } as Destination
  return { supervisor, destination, bindConnection, removeBinding }
}

function connection(settled = Promise.resolve()) {
  let active = true
  const listeners = new Set<() => void>()
  const dispose = vi.fn(() => {
    active = false
    for (const listener of listeners) {
      listener()
    }
    return settled
  })
  return {
    isActive: () => active,
    dispose,
    multiplexer: {
      onDispose: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  } as unknown as Connection
}

it('retires one destination after synchronous observers and leaves siblings active', async () => {
  const { supervisor, destination, removeBinding } = setup()
  const first = connection()
  const second = connection()
  vi.mocked(connectOrcadDelegatedTransfer)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  const sibling = { ...identity, bridgeId: 'retirement-sibling', terminalId: 'sibling' }
  supervisor.track(destination)
  supervisor.track({ ...destination, identity: sibling })
  await vi.advanceTimersByTimeAsync(0)
  const retirement = supervisor.retire(identity)
  expect(supervisor.retire(identity)).toBe(retirement)
  expect(first.isActive()).toBe(true)
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(() => supervisor.retry(identity)).toThrow('destination_retired')
  expect(() => supervisor.track(destination)).toThrow('destination_retired')
  await retirement
  expect(first.isActive()).toBe(false)
  expect(removeBinding).toHaveBeenCalledOnce()
  expect(supervisor.getConnection(sibling)).toBe(second)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledTimes(2)
})

it('cancels a queued retry and rejects a stale identity without touching the route', async () => {
  const { supervisor, destination } = setup()
  const first = connection()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(first)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  expect(() => supervisor.retire({ ...identity, incarnationId: 'stale' })).toThrow(
    'destination_unavailable'
  )
  expect(supervisor.getConnection(identity)).toBe(first)
  void first.dispose()
  expect(vi.getTimerCount()).toBe(1)
  await supervisor.retire(identity)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
})

it('fences a late startup result and waits for its cleanup through shutdown', async () => {
  const { supervisor, destination, bindConnection } = setup()
  let resolve!: (value: Connection) => void
  let finish!: () => void
  const cleanup = new Promise<void>((done) => {
    finish = done
  })
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  const retired = vi.fn()
  const retirement = supervisor.retire(identity).then(retired)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].signal.aborted).toBe(true)
  const late = connection(cleanup)
  resolve(late)
  await vi.advanceTimersByTimeAsync(0)
  const stopped = vi.fn()
  const stopping = supervisor.stop().then(stopped)
  expect(late.dispose).toHaveBeenCalledOnce()
  expect(bindConnection).not.toHaveBeenCalled()
  expect(retired).not.toHaveBeenCalled()
  expect(stopped).not.toHaveBeenCalled()
  finish()
  await Promise.all([retirement, stopping])
  expect(retired).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledOnce()
})

it('retires before the queued initial connection starts', async () => {
  const { supervisor, destination } = setup()
  supervisor.track(destination)
  await supervisor.retire(identity)
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('recovers a durable retirement after transport loss without opening another connection', async () => {
  let retired = false
  const recover = vi.fn(() => retired)
  const { supervisor, destination } = setup(recover)
  const active = connection()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(active)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  retired = true
  void active.dispose()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(recover).toHaveBeenCalledTimes(2)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(supervisor.getConnection(identity)).toBeNull()
  expect(() => supervisor.retry(identity)).toThrow('destination_retired')
  await supervisor.stop()
})

it('retries failed local retirement recovery without contacting the source', async () => {
  let failed = true
  const recover = vi.fn(() => {
    if (failed) {
      throw new Error('retirement flush unavailable')
    }
    return true
  })
  const { supervisor, destination } = setup(recover)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  failed = false
  await vi.advanceTimersByTimeAsync(1_000)
  expect(recover).toHaveBeenCalledTimes(2)
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await supervisor.stop()
})

it('delivers an accepted exit to every provider observer before retirement disposal', async () => {
  const { supervisor, destination } = setup()
  const active = connection()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(active)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  let retirement!: Promise<void>
  const exits = new OrcadDelegatedProviderExits({
    isActive: active.isActive,
    onError: vi.fn(),
    onExit: () => {
      retirement = supervisor.retire(identity)
    }
  })
  const first = vi.fn()
  const second = vi.fn()
  exits.onExit(first)
  exits.onExit(second)
  exits.accept({ identity, exit: { code: 0 } } as OrcadDelegatedExitEvent)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(active.isActive()).toBe(true)
  await retirement
  expect(active.isActive()).toBe(false)
})

it('waits for an old model write without reconnecting after retirement', async () => {
  const { supervisor, destination } = setup()
  let finish!: () => void
  const cleanup = new Promise<void>((done) => {
    finish = done
  })
  const active = connection(cleanup)
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue(active)
  supervisor.track(destination)
  await vi.advanceTimersByTimeAsync(0)
  void active.dispose()
  await vi.advanceTimersByTimeAsync(1_000)
  const settled = vi.fn()
  const retirement = supervisor.retire(identity).then(settled)
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).not.toHaveBeenCalled()
  finish()
  await retirement
  await vi.advanceTimersByTimeAsync(120_000)
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
