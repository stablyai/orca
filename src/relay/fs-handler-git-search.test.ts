import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { EventEmitter, getEventListeners } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { searchWithGitGrep } from './fs-handler-git-search'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).pid = 1234
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  return p
}

function expectDetached(proc: ChildProcess, signal: AbortSignal): void {
  expect((proc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
  expect((proc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
  expect(proc.listenerCount('error')).toBe(0)
  expect(proc.listenerCount('close')).toBe(0)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

describe('relay git grep fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('settles and detaches when git grep ignores the timeout kill', async () => {
    vi.useFakeTimers()

    try {
      const proc = createMockProcess()
      spawnMock.mockReturnValue(proc)

      const promise = searchWithGitGrep('/remote/root', 'ok', { maxResults: 100 })

      ;(proc.stdout as unknown as EventEmitter).emit('data', 'valid.ts\x001\x00ok\npartial')

      await vi.runOnlyPendingTimersAsync()

      const result = await promise
      expect(result.truncated).toBe(true)
      expect(result.files).toHaveLength(1)
      expect(result.files[0].matchCount).toBe(1)
      expect(proc.kill).toHaveBeenCalled()
      expect((proc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((proc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(proc.listenerCount('error')).toBe(0)
      expect(proc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not spawn git grep for a pre-aborted search', async () => {
    const controller = new AbortController()
    controller.abort()

    const promise = searchWithGitGrep('/remote/root', 'ok', { maxResults: 100 }, controller.signal)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts an in-flight git grep and detaches every listener', async () => {
    const proc = createMockProcess()
    const controller = new AbortController()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/remote/root', 'ok', { maxResults: 100 }, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expectDetached(proc, controller.signal)
  })
})
