import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: spawnMock
}))

import type { ChildProcess } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { searchWithRg } from './fs-handler-utils'

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  ;(proc as unknown as Record<string, unknown>).pid = 1234
  ;(proc as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (proc as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(proc as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(proc as unknown as Record<string, unknown>).kill = vi.fn()
  return proc
}

function expectDetached(proc: ChildProcess, signal: AbortSignal): void {
  expect((proc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
  expect((proc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
  expect(proc.listenerCount('error')).toBe(0)
  expect(proc.listenerCount('close')).toBe(0)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

function rgMatchLine(): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/remote/root/src/index.ts' },
      line_number: 4,
      lines: { text: 'const ok = true\n' },
      submatches: [{ start: 6, end: 8 }]
    }
  })
}

describe('relay rg search cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not spawn rg for a pre-aborted search', async () => {
    const proc = createMockProcess()
    const controller = new AbortController()
    spawnMock.mockReturnValue(proc)
    controller.abort()

    const promise = searchWithRg('/remote/root', 'ok', { maxResults: 100 }, controller.signal)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts an in-flight rg search and detaches every listener', async () => {
    const proc = createMockProcess()
    const controller = new AbortController()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithRg('/remote/root', 'ok', { maxResults: 100 }, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expectDetached(proc, controller.signal)
  })

  it('returns partial truncated results when rg ignores the timeout kill', async () => {
    vi.useFakeTimers()
    try {
      const proc = createMockProcess()
      const controller = new AbortController()
      spawnMock.mockReturnValue(proc)

      const promise = searchWithRg('/remote/root', 'ok', { maxResults: 100 }, controller.signal)
      ;(proc.stdout as unknown as EventEmitter).emit('data', `${rgMatchLine()}\n`)

      await vi.runOnlyPendingTimersAsync()

      await expect(promise).resolves.toMatchObject({ totalMatches: 1, truncated: true })
      expect(proc.kill).toHaveBeenCalledTimes(1)
      expectDetached(proc, controller.signal)
    } finally {
      vi.useRealTimers()
    }
  })
})
