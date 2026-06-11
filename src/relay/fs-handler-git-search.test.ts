import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { searchWithGitGrep } from './fs-handler-git-fallback'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
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
})
