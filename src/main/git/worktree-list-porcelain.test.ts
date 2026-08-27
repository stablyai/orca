import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { listWorktrees, WORKTREE_LIST_TIMEOUT_MS } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
})

describe('listWorktrees', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('translates parsed path fields from line-block porcelain output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
        'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\nsparse\n\n'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )

    await expect(listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).resolves.toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    // Why: the non-sparse main worktree gets an fs probe of its sparse config
    // file; the linked worktree short-circuits on the parsed `sparse` token and
    // does not. Only one git subprocess runs regardless of worktree count.
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(translateWslOutputPathsMock).toHaveBeenCalledTimes(2)
  })

  it('passes the selected WSL distro when translating Windows-path worktree output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /mnt/c/Users/me/repo\nHEAD abc123\nbranch refs/heads/main\nsparse\n\n' +
        'worktree /mnt/c/Users/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\nsparse\n\n'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output
        .replace('/mnt/c/Users/me/repo-feature', 'C:\\Users\\me\\repo-feature')
        .replace('/mnt/c/Users/me/repo', 'C:\\Users\\me\\repo')
    )

    await expect(listWorktrees('C:\\Users\\me\\repo', { wslDistro: 'Ubuntu' })).resolves.toEqual([
      {
        path: 'C:\\Users\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isSparse: true,
        isMainWorktree: true
      },
      {
        path: 'C:\\Users\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: 'C:\\Users\\me\\repo',
      wslDistro: 'Ubuntu',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(translateWslOutputPathsMock).toHaveBeenCalledWith(
      expect.any(String),
      'C:\\Users\\me\\repo',
      { wslDistro: 'Ubuntu' }
    )
  })

  it('returns no worktrees when the repo path is gone', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn git ENOENT'), {
        code: 'ENOENT'
      })
    )
    statMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(listWorktrees('/workspace/deleted-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/workspace/deleted-repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(statMock).toHaveBeenCalledWith('/workspace/deleted-repo')
    expect(warnSpy).toHaveBeenCalledWith(
      '[git/worktree] repo path missing; skipping worktree list: /workspace/deleted-repo'
    )
    warnSpy.mockRestore()
  })

  it('returns no worktrees when the path exists but is not a git repo', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: git worktree list --porcelain'), {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )

    await expect(listWorktrees('/private/tmp/orca-issue-1582-test/my-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/private/tmp/orca-issue-1582-test/my-repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('detects sparse checkout after translating paths when porcelain omits sparse token', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.join(' ') === 'worktree list --porcelain -z') {
        return {
          stdout:
            'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
            'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n',
          stderr: ''
        }
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )
    const featureWorktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature'
    resolveGitDirMock.mockImplementation(async (worktreePath: string) =>
      worktreePath === featureWorktreePath
        ? `${featureWorktreePath}\\.git-worktrees\\feature`
        : `${worktreePath}/.git`
    )
    statMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('repo-feature') && filePath.includes('sparse-checkout')) {
        return { isFile: () => true, size: 32 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const worktrees = await listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')

    expect(worktrees).toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(resolveGitDirMock).toHaveBeenCalledWith(featureWorktreePath)
    // Why: the detection path must not spawn a git subprocess per worktree —
    // the perf regression in #1131 came from `git sparse-checkout list` firing
    // on every poll.
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
  })

  it('bounds concurrent sparse-checkout filesystem probes', async () => {
    const worktreeCount = 20
    const sparseWorktreePath = '/repo-worktree-17'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: Array.from({ length: worktreeCount }, (_, index) =>
        [
          `worktree ${index === 0 ? '/repo' : `/repo-worktree-${index}`}`,
          `HEAD ${String(index).padStart(6, '0')}`,
          `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
          ''
        ].join('\n')
      ).join('\n'),
      stderr: ''
    })

    const pendingProbeResolves: (() => void)[] = []
    let activeProbes = 0
    let maxActiveProbes = 0
    statMock.mockImplementation(async (filePath: string) => {
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      await new Promise<void>((resolve) => pendingProbeResolves.push(resolve))
      activeProbes -= 1

      if (filePath.replaceAll('\\', '/').includes(sparseWorktreePath)) {
        return { isFile: () => true, size: 32 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    let completed = false
    const listPromise = listWorktrees('/repo').finally(() => {
      completed = true
    })

    for (let attempt = 0; pendingProbeResolves.length < 8 && attempt < 50; attempt += 1) {
      await Promise.resolve()
    }
    expect(pendingProbeResolves).toHaveLength(8)

    // Why: each probe may chain extra microtasks after stat (e.g. core.sparseCheckout
    // config reads). Drain until the list settles, not a fixed microtask budget.
    for (let attempt = 0; !completed && attempt < 100; attempt += 1) {
      pendingProbeResolves.splice(0).forEach((resolve) => resolve())
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(completed).toBe(true)

    const worktrees = await listPromise

    expect(maxActiveProbes).toBeLessThanOrEqual(8)
    expect(statMock).toHaveBeenCalledTimes(worktreeCount)
    expect(worktrees).toHaveLength(worktreeCount)
    expect(worktrees[17]).toMatchObject({
      path: sparseWorktreePath,
      isSparse: true
    })
  })

  it('falls back to line-block porcelain output when Git rejects -z', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
      }
    })
    // Why: the fallback probes each linked worktree path for existence; keep
    // the paths "present" so this test stays about parser selection.
    statMock.mockImplementation(async (targetPath: string) => {
      if (String(targetPath).endsWith('sparse-checkout')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {}
    })

    await expect(listWorktrees('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      }
    ])
    expect(getGitCalls()).toEqual([
      'git worktree list --porcelain -z',
      'git worktree list --porcelain'
    ])
  })

  it('annotates missing linked worktrees as prunable via the line-block fallback', async () => {
    // Why: Git <2.36 lacks the `prunable` porcelain field (issue #8389), so
    // the fallback must probe each linked worktree path instead of treating a
    // stale registration as a live workspace.
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n' +
          'worktree /repo-locked\nHEAD aaa789\nbranch refs/heads/agent\nlocked agent session\n'
      }
    })
    // statMock default (beforeEach): every path is missing (ENOENT).

    const worktrees = await listWorktrees('/repo')

    expect(worktrees.find((worktree) => worktree.path === '/repo-feature')).toMatchObject({
      prunable: true
    })
    // Locked registrations are shielded, mirroring git's own prunable rules;
    // the main worktree is covered by the repo-level missing-path handling.
    expect(worktrees.find((worktree) => worktree.path === '/repo-locked')?.prunable).toBeUndefined()
    expect(worktrees.find((worktree) => worktree.path === '/repo')?.prunable).toBeUndefined()
  })
})
