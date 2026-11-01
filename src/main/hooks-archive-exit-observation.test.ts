import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Repo } from '../shared/repo-types'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('child_process', () => ({ spawn: spawnMock, execFileSync: vi.fn() }))
vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: () => ({ scripts: { archive: 'do-the-archive' } })
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

/** EventEmitter preserves Node’s fatal unhandled-error behavior while replaying chunks. */
class FakeStream extends EventEmitter {
  constructor(private readonly chunks: string[]) {
    super()
  }
  setEncoding(): void {}
  override on(event: string, fn: (chunk: string) => void): this {
    super.on(event, fn)
    if (event === 'data') {
      for (const chunk of this.chunks) {
        fn(chunk)
      }
    }
    return this
  }
}

function fakeChild(
  outcome: { code?: number | null; signal?: NodeJS.Signals | null } | Error,
  stdoutChunks: string[] = [],
  stdoutError?: Error
) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const stdout = new FakeStream(stdoutChunks)
  queueMicrotask(() => {
    if (stdoutError) {
      stdout.emit('error', stdoutError)
    }
    if (outcome instanceof Error) {
      for (const fn of listeners.error ?? []) {
        fn(outcome)
      }
      return
    }
    for (const fn of listeners.close ?? []) {
      fn(outcome.code ?? null, outcome.signal ?? null)
    }
  })
  return {
    pid: 4242,
    stdout,
    stderr: new FakeStream([]),
    exitCode: null,
    signalCode: null,
    kill: () => true,
    on(event: string, fn: (...args: unknown[]) => void) {
      ;(listeners[event] ??= []).push(fn)
      return this
    }
  }
}

async function runArchiveWith(
  outcome: { code?: number | null; signal?: NodeJS.Signals | null } | Error,
  stdoutChunks?: string[],
  stdoutError?: Error
): Promise<{ success: boolean; output: string; exitCode?: number }> {
  const { runHook } = await import('./hooks')
  spawnMock.mockImplementationOnce(() => fakeChild(outcome, stdoutChunks, stdoutError))
  const result = await runHook('archive', '/repo/wt', REPO)
  // Guard against a vacuous pass: if the mock stops intercepting, a real shell would run.
  expect(spawnMock).toHaveBeenCalled()
  return result
}

// Real-process timeout/group tests live in hook-termination-real-process.test.ts (#19334).
describe('archive hook exit observation', () => {
  it('passes a clean run through without an exit code', async () => {
    await expect(runArchiveWith({ code: 0 })).resolves.toEqual({ success: true, output: '' })
  })

  it.each([
    ['a non-zero exit', 23],
    ['a shell command-not-found', 127]
  ])('reports %s as the observed exit it is', async (_label, code) => {
    await expect(runArchiveWith({ code })).resolves.toMatchObject({
      success: false,
      exitCode: code
    })
  })

  it('caps what it retains from a hook that floods stdout', async () => {
    const megabyte = 'x'.repeat(1024 * 1024)
    const result = await runArchiveWith(
      { code: 0 },
      Array.from({ length: 12 }, () => megabyte)
    )
    expect(result.output.length).toBeLessThan(11 * 1024 * 1024)
    expect(result.output).toContain('output truncated at 10485760 bytes')
  })

  it('survives an error on the output stream', async () => {
    await expect(
      runArchiveWith({ code: 0 }, ['partial'], new Error('EIO: read failed'))
    ).resolves.toMatchObject({ success: true })
  })

  it('names a signalled exit as one rather than reporting "exit code null"', async () => {
    const result = await runArchiveWith({ code: null, signal: 'SIGKILL' })
    expect(result.output).toContain('terminated without reporting an exit code')
  })

  it.each([
    ['was killed by a signal', { code: null, signal: 'SIGKILL' as const }],
    // Spawn errors carry string codes; a bare Error would not exercise the numeric-code guard.
    ['never started', Object.assign(new Error('spawn /bin/bash ENOENT'), { code: 'ENOENT' })]
  ])('withholds the exit code when the hook %s', async (_label, outcome) => {
    const result = await runArchiveWith(outcome)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })
})
