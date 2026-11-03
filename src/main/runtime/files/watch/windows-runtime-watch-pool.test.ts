import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WindowsRuntimeWatchPool } from './windows-runtime-watch-pool'
import { WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS } from './windows-file-watch'

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }))
vi.mock('node:fs', () => ({ watch: watchMock }))

function installWatcher(close?: () => void) {
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(() => (close ? close() : watcher.emit('close')))
  })
  let notify = () => undefined
  watchMock.mockImplementationOnce((_root, _options, callback) => {
    notify = callback
    return watcher
  })
  return { watcher, notify: () => notify() }
}

beforeEach(() => {
  vi.useFakeTimers()
  watchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('shares one native watch and refresh timer across path aliases', async () => {
  const pool = new WindowsRuntimeWatchPool()
  const { watcher, notify } = installWatcher()
  const callbacks = Array.from({ length: 3 }, () => vi.fn())
  const releases = await Promise.all(
    callbacks.map((callback, index) =>
      pool.watch(index % 2 === 0 ? 'C:\\repo' : 'c:/REPO', callback, vi.fn())
    )
  )
  expect(watchMock).toHaveBeenCalledOnce()
  notify()
  expect(vi.getTimerCount()).toBe(1)
  await releases[0]()
  expect(watcher.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(callbacks[0]).not.toHaveBeenCalled()
  for (const callback of callbacks.slice(1)) {
    expect(callback).toHaveBeenCalledExactlyOnceWith([
      { kind: 'overflow', absolutePath: 'C:\\repo' }
    ])
  }
  await Promise.all(releases.slice(1).map((release) => release()))
  expect(watcher.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels a successor waiting on physical close without starting another watch', async () => {
  const pool = new WindowsRuntimeWatchPool()
  const first = installWatcher(() => undefined)
  const release = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  const closing = release()
  const controller = new AbortController()
  const successor = pool.watch('C:\\repo', vi.fn(), vi.fn(), controller.signal)
  controller.abort(new Error('successor cancelled'))
  await expect(successor).rejects.toThrow('successor cancelled')
  expect(watchMock).toHaveBeenCalledOnce()
  first.watcher.emit('close')
  await closing
  const replacement = installWatcher()
  const releaseReplacement = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  expect(watchMock).toHaveBeenCalledTimes(2)
  await releaseReplacement()
  expect(replacement.watcher.close).toHaveBeenCalledOnce()
})

it('retries failed close on the original owner before admitting a replacement', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const pool = new WindowsRuntimeWatchPool()
  const first = installWatcher()
  const failure = new Error('native close failed')
  first.watcher.close.mockImplementationOnce(() => {
    throw failure
  })
  const release = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  await expect(release()).rejects.toBe(failure)
  await expect(pool.watch('C:\\repo', vi.fn(), vi.fn())).rejects.toBe(failure)
  expect(watchMock).toHaveBeenCalledOnce()
  await release()
  expect(first.watcher.close).toHaveBeenCalledTimes(2)
  installWatcher()
  const releaseReplacement = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  expect(watchMock).toHaveBeenCalledTimes(2)
  await releaseReplacement()
})

it('retains a timed-out root until late physical exit and keeps cleanup retryable', async () => {
  const pool = new WindowsRuntimeWatchPool()
  const first = installWatcher(() => undefined)
  const release = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  const closing = release()
  const rejected = expect(closing).rejects.toMatchObject({
    code: 'process_unavailable',
    physicalExit: expect.any(Promise)
  })
  await vi.advanceTimersByTimeAsync(WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS)
  await rejected
  installWatcher()
  const successor = pool.watch('C:\\repo', vi.fn(), vi.fn())
  await Promise.resolve()
  expect(watchMock).toHaveBeenCalledOnce()
  const retry = release()
  first.watcher.emit('close')
  await retry
  const releaseSuccessor = await successor
  expect(watchMock).toHaveBeenCalledTimes(2)
  expect(first.watcher.close).toHaveBeenCalledOnce()
  await releaseSuccessor()
})

it('fans out terminal errors once and keeps old cleanup from evicting a new generation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const pool = new WindowsRuntimeWatchPool()
  const first = installWatcher()
  const firstError = vi.fn()
  const secondError = vi.fn()
  const releaseFirst = await pool.watch('C:\\repo', vi.fn(), firstError)
  const releaseSecond = await pool.watch('C:\\repo', vi.fn(), secondError)
  const failure = new Error('native watcher failed')
  first.watcher.emit('error', failure)
  expect(firstError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(secondError).toHaveBeenCalledExactlyOnceWith(failure)
  const replacement = installWatcher()
  const replacementEvents = vi.fn()
  const releaseReplacement = await pool.watch('C:\\repo', replacementEvents, vi.fn())
  await Promise.all([releaseFirst(), releaseSecond()])
  const releaseJoiner = await pool.watch('C:\\repo', vi.fn(), vi.fn())
  expect(watchMock).toHaveBeenCalledTimes(2)
  replacement.notify()
  await vi.advanceTimersByTimeAsync(500)
  expect(replacementEvents).toHaveBeenCalledOnce()
  await Promise.all([releaseReplacement(), releaseJoiner()])
})
