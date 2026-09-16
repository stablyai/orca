import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

import { ghExecFileAsync } from './gh-exec-file'
import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'

function mockChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

/**
 * #18234 took four rounds of strace/perf/proc spelunking from the reporter
 * because a deadline kill produced no evidence at all. The resolved path is the
 * fact that names a self-recursive wrapper.
 */
describe('hosted CLI deadline logging', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(process, 'kill').mockImplementation((() => true) as unknown as typeof process.kill)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('names the CLI, the deadline and the resolved path, and never the argv values', () => {
    logHostedCliDeadlineKill(
      'gh',
      '/home/user/.local/bin/gh',
      ['api', '-H', 'Authorization: token ghp_secret'],
      15_000
    )

    const line = warn.mock.calls[0][0] as string
    expect(line).toContain('[gh]')
    expect(line).toContain('15000ms')
    expect(line).toContain('/home/user/.local/bin/gh')
    expect(line).toContain('"api"')
    expect(line).toContain('(3 args)')
    expect(line).not.toContain('ghp_secret')
    expect(line).not.toContain('Authorization')
  })

  it('logs once when gh is killed at its deadline', async () => {
    spawnMock.mockReturnValue(mockChild())

    const rejection = expect(
      ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection

    const deadlineLines = warn.mock.calls.filter((call) => String(call[0]).startsWith('[gh]'))
    expect(deadlineLines).toHaveLength(1)
    expect(String(deadlineLines[0][0])).toContain('wrapper script')
  })

  it('stays quiet when the caller aborted rather than the deadline firing', async () => {
    const controller = new AbortController()
    spawnMock.mockReturnValue(mockChild())

    const rejection = expect(
      ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
        timeout: 15_000,
        signal: controller.signal
      })
    ).rejects.toThrow()
    controller.abort()
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection

    expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('[gh]'))).toHaveLength(0)
  })
})
