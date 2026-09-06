import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, gitRunner, setPlatform } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  isOriginMainBaseRefProbe,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('routes local WSL project worktree drift probes through runtime git options', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const wslGitOptions = { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
    let driftCounts = '1\t2\n'
    const asyncGitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: `${TEST_REPO_PATH}/.git\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: driftCounts, stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: 'base commit 2\nbase commit 1\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    try {
      const result = await runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        base: 'origin/main',
        behind: 2,
        recentSubjects: ['base commit 2', 'base commit 1']
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        { ...wslGitOptions, timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['remote'], wslGitOptions)
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        wslGitOptions
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['fetch', 'origin'], {
        ...wslGitOptions,
        timeout: 60_000
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['log', '--format=%s', '-n', '5', 'HEAD..origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )

      driftCounts = '3\t0\n'
      asyncGitSpy.mockClear()

      await expect(runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
        base: 'origin/main',
        behind: 0,
        recentSubjects: []
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy.mock.calls.some(([args]) => args[0] === 'log')).toBe(false)
    } finally {
      asyncGitSpy.mockRestore()
    }
  })
})
