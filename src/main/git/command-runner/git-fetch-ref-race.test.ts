import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('./process-capture/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('../../../shared/git/fetch/git-fetch-head-lock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithGitFetchHeadLock: (_cwd: string, _signal: AbortSignal | undefined, run: () => unknown) =>
    run()
}))

import { gitExecFileAsync } from './git-exec-file'

const CAS_DIAGNOSTIC =
  'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided'
const options = { cwd: '/repo', env: { GIT_SSH_COMMAND: 'ssh' } }

function failure(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(stderr), { code: 1, stderr, ...extra })
}

function answerWith(...outcomes: (Error | string)[]): void {
  capture.mockImplementation((_command, _args, captureOptions) => {
    captureOptions.onChildTerminated()
    const outcome = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve({ stdout: outcome, stderr: '' })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  capture.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('standalone fetch ref-update recovery', () => {
  it.each([
    CAS_DIAGNOSTIC,
    `${CAS_DIAGNOSTIC}\n ! aaaaaaa..bbbbbbb main -> origin/main (unable to update local ref)`,
    "error: cannot lock ref 'refs/remotes/upstream/main': is at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa but expected bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ])('recovers a failed fetch after %s', async (diagnostic) => {
    answerWith(failure(diagnostic), 'fresh refs')
    const result = gitExecFileAsync(['-c', 'gc.auto=0', 'fetch', 'origin'], options)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual({ stdout: 'fresh refs', stderr: '' })
  })

  it('waits for the failed foreground child to exit before replaying fetch', async () => {
    let exited = false
    capture.mockImplementationOnce((_command, _args, captureOptions) => {
      setTimeout(() => {
        exited = true
        captureOptions.onChildTerminated()
      }, 1_000)
      return Promise.reject(failure(CAS_DIAGNOSTIC))
    })
    capture.mockImplementation((_command, _args, captureOptions) => {
      captureOptions.onChildTerminated()
      return exited
        ? Promise.resolve({ stdout: 'fresh refs', stderr: '' })
        : Promise.reject(new Error('The previous writer is still running'))
    })
    const result = gitExecFileAsync(['fetch', 'origin'], options)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual({ stdout: 'fresh refs', stderr: '' })
  })

  it('retains the original failure when ref contention persists', async () => {
    const original = failure(CAS_DIAGNOSTIC)
    answerWith(original)
    const result = gitExecFileAsync(['fetch', 'origin'], options)
    const rejection = expect(result).rejects.toMatchObject({
      cause: original,
      message: expect.stringContaining(
        'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided'
      )
    })
    await vi.runAllTimersAsync()
    await rejection
  })

  it.each([
    failure('fatal: Authentication failed'),
    failure(`${CAS_DIAGNOSTIC}\nfatal: Could not resolve host: example.invalid`),
    failure(`${CAS_DIAGNOSTIC}\nremote: error: access denied`),
    failure(`${CAS_DIAGNOSTIC}\nremote: ERROR access denied`),
    failure(`${CAS_DIAGNOSTIC}\nErrors during submodule fetch:\n\tsub`),
    failure(`${CAS_DIAGNOSTIC}\n ! [rejected] v1 -> v1 (would clobber existing tag)`),
    failure(`${CAS_DIAGNOSTIC}\n ! [forced-update-failed] main -> origin/main`),
    failure(`${CAS_DIAGNOSTIC}\nfatal: bad object HEAD`),
    failure(
      "error: cannot lock ref 'refs/heads/main': is at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa but expected bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ),
    failure("fatal: Unable to create '.git/refs/remotes/origin/main.lock': File exists"),
    failure(CAS_DIAGNOSTIC, { killed: true, signal: 'SIGTERM' }),
    failure(CAS_DIAGNOSTIC, { name: 'GitCommandTimeoutError' }),
    failure(CAS_DIAGNOSTIC, { outputTruncated: true }),
    Object.assign(new Error(CAS_DIAGNOSTIC), { stdout: CAS_DIAGNOSTIC })
  ])('preserves a non-retriable failure: %s', async (original) => {
    answerWith(original, 'failure was hidden')
    const result = gitExecFileAsync(['fetch', 'origin'], options)
    const rejection = expect(result).rejects.toBe(original)
    await vi.runAllTimersAsync()
    await rejection
  })

  it('cancels the backoff instead of turning a cancelled fetch into success', async () => {
    const controller = new AbortController()
    answerWith(failure(CAS_DIAGNOSTIC), 'failure was hidden')
    const result = gitExecFileAsync(['fetch', 'origin'], {
      ...options,
      signal: controller.signal,
      observeChildTermination: (terminated) => {
        void terminated.then(() => setTimeout(() => controller.abort(), 10))
      }
    })
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.runAllTimersAsync()
    await rejection
  })

  it('surfaces a different failure from a later fetch attempt unchanged', async () => {
    const terminal = failure('fatal: Authentication failed')
    answerWith(failure(CAS_DIAGNOSTIC), terminal, 'failure was hidden')
    const result = gitExecFileAsync(['fetch', 'origin'], options)
    const rejection = expect(result).rejects.toBe(terminal)
    await vi.runAllTimersAsync()
    await rejection
  })

  it('preserves the fetch failure when its owner loses eligibility before retry', async () => {
    const original = failure(CAS_DIAGNOSTIC)
    let eligible = true
    capture.mockImplementationOnce((_command, _args, captureOptions) => {
      captureOptions.onChildTerminated()
      eligible = false
      return Promise.reject(original)
    })
    answerWith('failure was hidden')
    const result = gitExecFileAsync(['fetch', 'origin'], {
      ...options,
      canStart: () => eligible
    })
    const rejection = expect(result).rejects.toBe(original)
    await vi.runAllTimersAsync()
    await rejection
  })

  it('preserves pull failures even when stderr resembles a failed fetch', async () => {
    const original = failure(CAS_DIAGNOSTIC)
    capture.mockImplementationOnce((_command, _args, captureOptions) => {
      captureOptions.onChildTerminated()
      return Promise.reject(original)
    })
    answerWith('Already up to date')
    const result = gitExecFileAsync(['pull', '--ff-only'], options)
    const rejection = expect(result).rejects.toBe(original)
    await vi.runAllTimersAsync()
    await rejection
  })
})
