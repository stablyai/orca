import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('child_process', () => ({
  exec: execMock,
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: () => ({ scripts: { archive: 'do-the-archive' } })
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

const execFailure = (code: unknown): Error => Object.assign(new Error('Command failed'), { code })

/** Drive runHook once with the error object `exec` hands back for a given failure mode. */
async function runArchiveWith(
  error: Error | null
): Promise<{ success: boolean; exitCode?: number }> {
  const { runHook } = await import('./hooks')
  execMock.mockImplementationOnce((_script, _opts, cb) => {
    cb(error, '', '')
    return { pid: 1234, kill: vi.fn() }
  })
  const outcome = await runHook('archive', '/repo/wt', REPO)
  // Guard against a vacuous pass: if the mock ever stops intercepting, a real shell would run and
  // this, rather than the subtle assertions below, is what fails.
  expect(execMock).toHaveBeenCalled()
  return outcome
}

// Why (#19334): an ABSENT exitCode is what the removal gate reads as `unverifiable`. The guard is
// `typeof code === 'number'`, because `exec` reports a spawn failure with a *string* code — a
// looser null-check would file ENOENT as `exited "ENOENT"`, reading a hook that never ran as one
// that reported an exit. The timeout arm of the same contract is covered against a real shell in
// hook-archive-timeout-observation.test.ts.
describe('archive hook exit observation', () => {
  it('passes a clean run through without an exit code', async () => {
    await expect(runArchiveWith(null)).resolves.toEqual({ success: true, output: '' })
  })

  it.each([
    ['a non-zero exit', 23],
    ['a shell command-not-found', 127]
  ])('reports %s as the observed exit it is', async (_label, code) => {
    await expect(runArchiveWith(execFailure(code))).resolves.toMatchObject({
      success: false,
      exitCode: code
    })
  })

  it.each([
    ['was killed by a signal', null],
    ['never started, so the code is a string', 'ENOENT']
  ])('withholds the exit code when the hook %s', async (_label, code) => {
    const result = await runArchiveWith(execFailure(code))
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })
})
