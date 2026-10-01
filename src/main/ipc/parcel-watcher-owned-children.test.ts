import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherOwnedChildren } from './parcel-watcher-owned-children'
import {
  registerWatcherChildPhysicalExit,
  signalWatcherChild,
  WATCHER_PROCESS_EXIT_DEADLINE_MS,
  WATCHER_PROCESS_HARD_KILL_DELAY_MS
} from './parcel-watcher-child-termination'

afterEach(() => vi.useRealTimers())

function child() {
  const exitState: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null
  }
  const events = Object.assign(new EventEmitter(), exitState, { kill: vi.fn(() => true) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: termination reads only the exit fields, kill and events stubbed here.
  const process = events as unknown as ChildProcess
  const physicalExit = registerWatcherChildPhysicalExit(process)
  events.on('exit', physicalExit)
  events.on('close', physicalExit)
  events.on('error', () => {})
  return { process, events, close: () => events.emit('close') }
}

it('joins disposal and does not confuse disconnect/error with physical exit', async () => {
  const owner = new WatcherOwnedChildren()
  const c = child()
  owner.track(c.process)
  const logical = vi.fn()
  const disposed = vi.fn()
  const first = owner.disposeAndWait(logical)
  expect(owner.disposeAndWait(logical)).toBe(first)
  const result = first.then(disposed)
  c.events.emit('disconnect')
  c.events.emit('error', new Error('spawn or IPC failure'))
  await Promise.resolve()
  expect(disposed).not.toHaveBeenCalled()
  expect(logical).toHaveBeenCalledOnce()
  c.close()
  await result
  expect(disposed).toHaveBeenCalledOnce()
})

it('includes children already signaled by synchronous or retired-owner disposal', async () => {
  const owner = new WatcherOwnedChildren()
  const old = child()
  const replacement = child()
  owner.track(old.process)
  old.process.kill()
  owner.track(replacement.process)
  const disposed = vi.fn()
  const result = owner.disposeAndWait(() => {}).then(disposed)
  replacement.close()
  await Promise.resolve()
  expect(disposed).not.toHaveBeenCalled()
  old.close()
  await result
})

it('retains a child after termination deadline failure and supports explicit retry', async () => {
  vi.useFakeTimers()
  const owner = new WatcherOwnedChildren()
  const c = child()
  owner.track(c.process)
  const result = owner.disposeAndWait(() => {}).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)
  expect(await result).toMatchObject({ message: 'watcher_owned_children_shutdown_incomplete' })
  const completed = vi.fn()
  const retry = owner.disposeAndWait(() => {}).then(completed)
  await Promise.resolve()
  expect(completed).not.toHaveBeenCalled()
  c.close()
  await retry
})

it('waits for other children even when logical disposal and one kill fail', async () => {
  const owner = new WatcherOwnedChildren()
  const failed = child()
  const pending = child()
  owner.track(failed.process)
  owner.track(pending.process)
  failed.events.kill.mockImplementationOnce(() => {
    throw new Error('kill failed')
  })
  const logicalFailure = new Error('logical cleanup failed')
  const finished = vi.fn()
  const result = owner
    .disposeAndWait(() => {
      throw logicalFailure
    })
    .catch((error: unknown) => {
      finished()
      return error
    })
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  pending.close()
  expect(await result).toMatchObject({ errors: [logicalFailure, expect.any(Error)] })
  const retry = owner.disposeAndWait(() => {})
  failed.close()
  await retry
})

it('skips a second graceful signal after the supervisor sent one but still escalates', async () => {
  vi.useFakeTimers()
  const owner = new WatcherOwnedChildren()
  const c = child()
  owner.track(c.process)
  const disposal = owner.disposeAndWait(() => signalWatcherChild(c.process))
  expect(c.events.kill).toHaveBeenCalledTimes(1)
  expect(c.events.kill).toHaveBeenCalledWith()
  await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_HARD_KILL_DELAY_MS)
  expect(c.events.kill).toHaveBeenLastCalledWith('SIGKILL')
  c.events.emit('exit', null, 'SIGKILL')
  await expect(disposal).resolves.toBeUndefined()
})
