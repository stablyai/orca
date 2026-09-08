import { expect, it, vi } from 'vitest'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../main/git/runner', () => ({ gitExecFileAsync: run }))
vi.mock('../main/git/status', () => ({
  runWithGitReadCacheInvalidation: (fn: () => unknown) => fn()
}))
vi.mock('../main/git/local-repo-ref-maintenance', () => ({
  postponeRepoRefMaintenance: () => {},
  withRepoRefMaintenancePaused: (_key: string, fn: () => unknown) => fn()
}))
import { gitPull, gitFastForward } from '../main/git/remote'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

it.each([
  ['https://github.com/canonical/repo.git', true, true],
  ['file:///canonical/repo.git', true, false],
  ['/canonical/repo.git', false, false],
  ['git@example.invalid:canonical/repo', false, false],
  ['rewrite:canonical/repo', false, false]
] as const)(
  'keeps pull intent %s with optional tracking on both hosts',
  async (url, matched, tracked) => {
    const calls: string[][] = []
    const script = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(
          "fatal: upstream branch 'refs/heads/feature' not stored as a remote-tracking branch"
        )
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '\0\n', stderr: '' }
      }
      if (args[0] === 'config') {
        const values: Record<string, string> = {
          'branch.feature.remote': url,
          'branch.feature.merge': 'refs/heads/feature'
        }
        if (!(args[2] in values)) {
          throw Object.assign(new Error('missing config'), { code: 1 })
        }
        return { stdout: values[args[2]], stderr: '' }
      }
      if (args[0] === 'remote') {
        return {
          stdout: `origin\t${matched ? url : 'https://example.invalid/other'} (fetch)\norigin\thttps://github.com/contributor/repo.git (push)`,
          stderr: ''
        }
      }
      if (args[0] === 'rev-parse' && !tracked) {
        throw Object.assign(new Error('missing ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    }
    run.mockImplementation(script)
    await gitPull('/repo')
    expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', url, 'refs/heads/feature'])
    expect(calls.some((args) => args.includes('refs/remotes/origin/feature'))).toBe(false)
    expect(calls.some((args) => args.includes('HEAD@{u}'))).toBe(false)
    calls.length = 0
    await gitFastForward('/repo')
    expect(calls.find((args) => args[0] === 'pull')).toEqual([
      'pull',
      '--ff-only',
      url,
      'refs/heads/feature'
    ])
    calls.length = 0
    const dispatcher = createMockDispatcher()
    const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    vi.spyOn(handler as unknown as { git: typeof script }, 'git').mockImplementation(script)
    await dispatcher.callRequest('git.pull', { worktreePath: '/repo' })
    expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', url, 'refs/heads/feature'])
    calls.length = 0
    await dispatcher.callRequest('git.fastForward', { worktreePath: '/repo' })
    expect(calls.find((args) => args[0] === 'pull')).toEqual([
      'pull',
      '--ff-only',
      url,
      'refs/heads/feature'
    ])
  }
)
