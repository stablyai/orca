import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('child_process', () => ({
  exec: execMock,
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn()
}))
// runHook resolves the script through this module; stub it so the test owns the hook definition.
vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: () => ({ scripts: { archive: 'do-the-archive' } })
}))

const REPO = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 } as Repo

/** Drive runHook once with the error object `exec` would hand back for a given failure mode. */
async function runArchiveWith(error: unknown): Promise<{ success: boolean; exitCode?: number }> {
  const { runHook } = await import('./hooks')
  execMock.mockImplementationOnce((_script, _opts, cb) => cb(error, '', ''))
  return runHook('archive', '/repo/wt', REPO)
}

// Why (#19334): the gate reads an ABSENT exitCode as `unverifiable`. That hinges on a
// `typeof === 'number'` guard, because exec reports a spawn failure with a *string* code. A
// looser null-check would file ENOENT as `exited "ENOENT"` and read it as an observed exit.
describe('archive hook exit observation', () => {
  it('reports an observed non-zero exit', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 23, signal: null })
    await expect(runArchiveWith(err)).resolves.toMatchObject({ success: false, exitCode: 23 })
  })

  it('reports a shell "command not found" as the observed 127 it is', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 127, signal: null })
    await expect(runArchiveWith(err)).resolves.toMatchObject({ success: false, exitCode: 127 })
  })

  it.each([
    ['killed by a signal', { code: null, signal: 'SIGKILL' }],
    ['timed out', { code: null, signal: 'SIGTERM' }],
    ['failed to spawn (string code)', { code: 'ENOENT', signal: null }]
  ])('withholds the exit code when none was observed: %s', async (_label, shape) => {
    const result = await runArchiveWith(Object.assign(new Error('Command failed'), shape))
    expect(result.success).toBe(false)
    expect(result.exitCode).toBeUndefined()
  })
})
