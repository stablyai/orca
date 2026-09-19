import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acknowledgeWatcherSubscribe, FakeWatcherChild } from './parcel-watcher-process-test-child'
import { resetWatcherChildRegistryForTest } from './parcel-watcher-child-registry'

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-disposal-test'),
  rmSync: vi.fn()
}))
import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'

const children: FakeWatcherChild[] = []
beforeEach(() => {
  resetWatcherChildRegistryForTest()
  forkMock.mockImplementation(() => {
    const child = new FakeWatcherChild()
    children.push(child)
    return child
  })
})
afterEach(() => {
  for (const child of children.splice(0)) {
    child.emit('close')
  }
  vi.clearAllMocks()
  resetWatcherChildRegistryForTest()
})

async function subscribe(supervisor: WatcherProcessSupervisor): Promise<FakeWatcherChild> {
  const pending = supervisor.subscribe('/repo', vi.fn(), {})
  const child = children.at(-1)!
  acknowledgeWatcherSubscribe(child)
  await pending
  return child
}

it('awaited supervisor disposal retains a child after prior synchronous disposal', async () => {
  const supervisor = new WatcherProcessSupervisor({ useInProcessVitestFallback: false })
  const child = await subscribe(supervisor)
  supervisor.dispose()
  const finished = vi.fn()
  const shutdown = supervisor.disposeAndWait().then(finished)
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  await expect(supervisor.subscribe('/another', vi.fn(), {})).rejects.toThrow()
  expect(forkMock).toHaveBeenCalledOnce()
  child.emit('close')
  await shutdown
  expect(finished).toHaveBeenCalledOnce()
})

it('test reset isolates old physical-exit callbacks from the new lifetime owner', async () => {
  const supervisor = new WatcherProcessSupervisor({ useInProcessVitestFallback: false })
  const old = await subscribe(supervisor)
  const oldShutdown = supervisor.disposeAndWait()
  supervisor.resetForTest()
  const current = await subscribe(supervisor)
  const finished = vi.fn()
  const shutdown = supervisor.disposeAndWait().then(finished)
  old.emit('close')
  await oldShutdown
  expect(finished).not.toHaveBeenCalled()
  current.emit('close')
  await shutdown
})
