import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Repo } from '../shared/repo-types'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('child_process', () => ({ spawn: spawnMock, execFileSync: vi.fn() }))
vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: () => ({ scripts: { archive: 'do-the-archive' } })
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

/**
 * A real EventEmitter, so an `error` with no listener throws exactly as Node's would — which is the
 * whole point of the stream-error row below. Replays its chunks to whoever subscribes to `data`.
 */
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

/** Minimal ChildProcess stand-in: runHook reads the streams and waits for close/error. */
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

// Why (#19334): an ABSENT exitCode is what the removal gate reads as `unverifiable`. Every row here
// is a way a hook can fail to deliver one. The timeout and termination arms of the same contract
// are covered against REAL processes in hook-termination-real-process.test.ts — deliberately not
// here, because a mocked child cannot show whether a process group exists.
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
    // `exec`'s 1 MiB maxBuffer is gone with `spawn`; without a cap a flooding hook grows the main
    // process's heap for the whole 120 s deadline.
    const megabyte = 'x'.repeat(1024 * 1024)
    const result = await runArchiveWith(
      { code: 0 },
      Array.from({ length: 12 }, () => megabyte)
    )
    expect(result.output.length).toBeLessThan(11 * 1024 * 1024)
    expect(result.output).toContain('output truncated at 10485760 bytes')
  })

  it('survives an error on the output stream', async () => {
    // An `error` with no listener is an uncaught exception, and in the main process that is the
    // app. `exec` never covered this either — its only `error` listener is on the child.
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
    // A real spawn failure carries a STRING code; the guard under test is `typeof code ===
    // 'number'`, so a bare Error would pass even if that guard regressed.
    ['never started', Object.assign(new Error('spawn /bin/bash ENOENT'), { code: 'ENOENT' })]
  ])('withholds the exit code when the hook %s', async (_label, outcome) => {
    const result = await runArchiveWith(outcome)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })
})
