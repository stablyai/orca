import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('./orcad-delegated-connection', () => ({ connectOrcadDelegatedTransfer: vi.fn() }))
type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
type Options = ConstructorParameters<typeof OrcadDelegatedConnectionSupervisor>[0]
const supervisors: OrcadDelegatedConnectionSupervisor[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  vi.mocked(connectOrcadDelegatedTransfer).mockReset()
  vi.useRealTimers()
})

function setup(bindConnection: NonNullable<Options['bindConnection']>) {
  const onError = vi.fn()
  const supervisor = new OrcadDelegatedConnectionSupervisor({
    signal: new AbortController().signal,
    onError,
    bindConnection
  })
  supervisors.push(supervisor)
  const destination = { identity, adapter: {}, outbox: {}, store: {} } as Parameters<
    typeof supervisor.track
  >[0]
  const opened: { result: Connection; dispose: ReturnType<typeof vi.fn<() => void>> }[] = []
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async () => {
    let active = true
    const listeners = new Set<() => void>()
    const dispose = vi.fn(() => {
      if (!active) {
        return
      }
      active = false
      for (const listener of listeners) {
        listener()
      }
    })
    const result = {
      isActive: () => active,
      dispose,
      multiplexer: {
        onDispose: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }
      }
    } as unknown as Connection
    opened.push({ result, dispose })
    return result
  })
  supervisor.track(destination)
  return { supervisor, opened, onError }
}

it('binds once per connection and removes the old binding before replacement', async () => {
  const order: string[] = []
  let generation = 0
  const bind = vi.fn<NonNullable<Options['bindConnection']>>(() => {
    const current = ++generation
    order.push(`bind-${current}`)
    return () => {
      order.push(`remove-${current}`)
    }
  })
  const f = setup(bind)
  await vi.advanceTimersByTimeAsync(0)
  expect(bind).toHaveBeenCalledWith(identity, f.opened[0].result)
  expect(Object.isFrozen(bind.mock.calls[0][0])).toBe(true)
  f.opened[0].dispose()
  expect(order).toEqual(['bind-1', 'remove-1'])
  await vi.advanceTimersByTimeAsync(1000)
  expect(order).toEqual(['bind-1', 'remove-1', 'bind-2'])
  await f.supervisor.stop()
  expect(order).toEqual(['bind-1', 'remove-1', 'bind-2', 'remove-2'])
})

it('fences a connected socket when its binding installer throws', async () => {
  const f = setup(() => {
    throw new Error('binding failed')
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.supervisor.getConnection(identity)).toBeNull()
  expect(f.opened[0].result.isActive()).toBe(false)
  expect(f.onError).toHaveBeenCalledWith(
    identity,
    expect.objectContaining({ message: 'binding failed' })
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.opened).toHaveLength(2)
  expect(f.opened.every(({ result }) => !result.isActive())).toBe(true)
})

it.each(['disconnect', 'stop'])('removes a binding returned after reentrant %s', async (mode) => {
  const remove = vi.fn()
  const f = setup((_identity, connection) => {
    if (mode === 'disconnect') {
      connection.dispose()
    } else {
      void f.supervisor.stop()
    }
    return remove
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(remove).toHaveBeenCalledOnce()
  expect(f.opened[0].result.isActive()).toBe(false)
  await f.supervisor.stop()
  expect(remove).toHaveBeenCalledOnce()
})

it('continues fencing all connections when one binding cleanup throws', async () => {
  const remove = vi.fn(() => {
    throw new Error('cleanup failed')
  })
  const f = setup(() => remove)
  await vi.advanceTimersByTimeAsync(0)
  f.supervisor.track({
    identity: { ...identity, bridgeId: 'second' },
    adapter: {},
    outbox: {},
    store: {}
  } as Parameters<typeof f.supervisor.track>[0])
  await vi.advanceTimersByTimeAsync(0)
  await f.supervisor.stop()
  expect(remove).toHaveBeenCalledTimes(2)
  expect(f.onError).toHaveBeenCalledTimes(2)
  expect(f.opened.every(({ result }) => !result.isActive())).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
