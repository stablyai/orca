import { describe, expect, it, vi } from 'vitest'

import type { GitWorktreeInfo } from '../shared/worktree/types'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree,
  getRegisteredDeletableWorktree,
  isDangerousWorktreeRemovalPath
} from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME, executionHostRemovalHome } from './worktree-removal-home-guard'

function makeGitWorktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: isMainWorktree ? 'refs/heads/main' : `refs/heads/${path.split('/').at(-1)}`,
    isBare: false,
    isMainWorktree
  }
}

function missingPath(path: string): Error & { code: string } {
  return Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
}

function makeStatPath(filePaths: readonly string[], directoryPaths: readonly string[] = []) {
  const files = new Set(filePaths)
  const directories = new Set(directoryPaths)
  return async (path: string) => {
    if (files.has(path)) {
      return { type: 'file' }
    }
    if (directories.has(path)) {
      return { type: 'directory' }
    }
    throw missingPath(path)
  }
}

function makeReadPath(entries: readonly (readonly [string, unknown])[]) {
  const files = new Map(entries)
  return async (path: string) => {
    if (!files.has(path)) {
      throw missingPath(path)
    }
    return files.get(path)
  }
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return await callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('getRegisteredDeletableWorktree', () => {
  it('rejects deleting a worktree that contains another registered worktree', () => {
    expect(() =>
      getRegisteredDeletableWorktree(
        '/repo',
        '/workspaces/parent',
        [
          makeGitWorktree('/repo', true),
          makeGitWorktree('/workspaces/parent'),
          makeGitWorktree('/workspaces/parent/child')
        ],
        CLIENT_REMOVAL_HOME
      )
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/child'
    )
  })

  it('does not reject sibling worktree paths that only share a prefix', () => {
    expect(
      getRegisteredDeletableWorktree(
        '/repo',
        '/workspaces/parent',
        [
          makeGitWorktree('/repo', true),
          makeGitWorktree('/workspaces/parent'),
          makeGitWorktree('/workspaces/parent-copy')
        ],
        CLIENT_REMOVAL_HOME
      )
    ).toMatchObject({ path: '/workspaces/parent' })
  })

  it('rejects deleting a worktree that contains another registered worktree in a dotdot-prefixed child', () => {
    expect(() =>
      getRegisteredDeletableWorktree(
        '/repo',
        '/workspaces/parent',
        [
          makeGitWorktree('/repo', true),
          makeGitWorktree('/workspaces/parent'),
          makeGitWorktree('/workspaces/parent/..child')
        ],
        CLIENT_REMOVAL_HOME
      )
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/..child'
    )
  })
})

describe('canSafelyRemoveOrphanedWorktreeDirectory', () => {
  it('accepts a linked worktree .git file that points at this repo worktrees entry', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n'],
          ['/repo/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('accepts repo worktree admin entries with dotdot-prefixed directory names', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/..orphan\n'],
          ['/repo/.git/worktrees/..orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('accepts remote filesystem provider readFile results for linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /repo/.git/worktrees/orphan\n' }
          ],
          [
            '/repo/.git/worktrees/orphan/gitdir',
            { isBinary: false, content: '/workspaces/orphan/.git\n' }
          ]
        ])
      )
    ).resolves.toBe(true)
  })

  it('preserves forward-slash UNC roots when probing linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '//Server/Share/orphan',
        '//Server/Repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['\\\\Server\\Share\\orphan\\.git'], ['\\\\Server\\Repo\\.git']),
        makeReadPath([
          ['\\\\Server\\Share\\orphan\\.git', 'gitdir: //Server/Repo/.git/worktrees/orphan\n'],
          ['\\\\Server\\Repo\\.git\\worktrees\\orphan\\gitdir', '//Server/Share/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('rejects a plain .git directory for unregistered cleanup', async () => {
    const readPath = vi.fn()

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        async () => ({ type: 'directory' }),
        readPath
      )
    ).resolves.toBe(false)

    expect(readPath).not.toHaveBeenCalled()
  })

  it('rejects a gitdir file that points outside this repo worktrees directory', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /other/.git/worktrees/orphan\n' }
          ]
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects a copied .git file when the admin entry points at another candidate path', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/other\n'],
          ['/repo/.git/worktrees/other/gitdir', '/workspaces/other/.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects POSIX admin backlinks that differ only by case', async () => {
    await withProcessPlatform('win32', async () => {
      await expect(
        canSafelyRemoveOrphanedWorktreeDirectory(
          '/workspaces/reused',
          '/repo',
          CLIENT_REMOVAL_HOME,
          makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
          makeReadPath([
            ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/reused\n'],
            ['/repo/.git/worktrees/reused/gitdir', '/workspaces/Reused/.git\n']
          ])
        )
      ).resolves.toBe(false)
    })
  })

  it('accepts a pruned admin entry when the candidate .git points under this repo worktrees dir', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']])
      )
    ).resolves.toBe(true)
  })

  it('rejects existing admin entries with a missing gitdir backlink', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git', '/repo/.git/worktrees/orphan']),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']])
      )
    ).resolves.toBe(false)
  })

  it('rejects symlink .git entries from remote lstat-shaped providers', async () => {
    const readPath = vi.fn()

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        async () => ({ type: 'symlink' }),
        readPath
      )
    ).resolves.toBe(false)

    expect(readPath).not.toHaveBeenCalled()
  })

  it('rejects separate-git-dir sibling repos when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /git/other.git\n'],
          ['/repo/.git', 'gitdir: /git/repo.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects separate git dirs under worktrees when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/reused/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /git/worktrees/other.git\n'],
          ['/repo/.git', 'gitdir: /git/worktrees/repo.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('accepts a repo path that is itself a linked worktree', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repos/main-linked',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/workspaces/orphan/.git', '/repos/main-linked/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /common/.git/worktrees/orphan\n'],
          ['/repos/main-linked/.git', 'gitdir: /common/.git/worktrees/main-linked\n'],
          ['/common/.git/worktrees/main-linked/gitdir', '/repos/main-linked/.git\n'],
          ['/common/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('rejects POSIX home directories even when host homedir has a different path shape', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/home/dev',
        '/repos/main',
        CLIENT_REMOVAL_HOME,
        makeStatPath(['/home/dev/.git'], ['/repos/main/.git']),
        makeReadPath([
          ['/home/dev/.git', 'gitdir: /repos/main/.git/worktrees/dev\n'],
          ['/repos/main/.git/worktrees/dev/gitdir', '/home/dev/.git\n']
        ])
      )
    ).resolves.toBe(false)
  })
})

describe('isDangerousWorktreeRemovalPath on an execution host', () => {
  // #18275: these verdicts are about the machine that runs the delete. The
  // client home is `homedir()` here — a macOS/Linux path that recognises none
  // of the Windows rows, and must not be what decides them either way.
  it.each([
    ['/Users', '/opt/src', true],
    ['/Users/alice', '/opt/src', true],
    ['/home/alice', '/opt/src', true],
    ['/home/alice/wt/foo', '/opt/src', false],
    ['C:\\Users\\bob', 'C:\\src\\repo', true],
    ['C:\\Users', 'C:\\src\\repo', true],
    ['C:\\Users\\bob\\wt\\foo', 'C:\\src\\repo', false]
  ])('%s under %s -> dangerous=%s', (worktreePath, repoPath, expected) => {
    // `/var/empty` is a resolved host home that matches no row, so each verdict comes from the
    // path rules alone — the same verdicts the client authority reaches.
    expect(
      isDangerousWorktreeRemovalPath(worktreePath, repoPath, executionHostRemovalHome('/var/empty'))
    ).toBe(expected)
    expect(isDangerousWorktreeRemovalPath(worktreePath, repoPath, CLIENT_REMOVAL_HOME)).toBe(
      expected
    )
  })

  it('refuses a registered worktree while the execution host home is unanswered', () => {
    // `git worktree add` accepts a pre-existing empty directory, and that directory can afterwards
    // be somebody's `$HOME` (a build account's home, a container's `HOME=/workspace`). So the
    // host's own Git registry proves provenance, not "this is not a home" — and `git worktree
    // remove --force` deletes the checkout. With the host's answer the path is caught by
    // containment; without it there is nothing left to catch a non-standard home shape.
    const registered = [makeGitWorktree('/opt/src/repo', true), makeGitWorktree('/srv/homes/alice')]

    expect(() =>
      findRegisteredDeletableWorktree(
        '/opt/src/repo',
        '/srv/homes/alice',
        registered,
        executionHostRemovalHome(null)
      )
    ).toThrow('Refusing to delete protected worktree path: /srv/homes/alice')
    expect(() =>
      findRegisteredDeletableWorktree(
        '/opt/src/repo',
        '/srv/homes/alice',
        registered,
        executionHostRemovalHome('/srv/homes/alice')
      )
    ).toThrow('Refusing to delete protected worktree path: /srv/homes/alice')
    // An answering host whose home is elsewhere still deletes it: the refusals above are the
    // missing answer and the matching answer, not the path.
    expect(
      findRegisteredDeletableWorktree(
        '/opt/src/repo',
        '/srv/homes/alice',
        registered,
        executionHostRemovalHome('/srv/homes/bob')
      )
    ).toEqual(registered[1])
  })

  it('refuses a home the host reported even when no path rule recognises it', () => {
    expect(
      isDangerousWorktreeRemovalPath(
        '/srv/homes/alice',
        '/opt/src',
        executionHostRemovalHome('/srv/homes/alice')
      )
    ).toBe(true)
  })

  it('recognises a POSIX home when the repo path drags the pair into win32 path ops', () => {
    // `getPathOps` reads both paths, so a `//`-rooted repo path put `/home/alice` under
    // Windows-only shape rules and the last guard on a recursive delete stopped matching.
    expect(
      isDangerousWorktreeRemovalPath(
        '/home/alice',
        '//nas/share/repo',
        executionHostRemovalHome('/var/empty')
      )
    ).toBe(true)
    expect(
      isDangerousWorktreeRemovalPath(
        '/srv/homes/alice',
        '//nas/share/repo',
        executionHostRemovalHome('/srv/homes/alice')
      )
    ).toBe(true)
    expect(
      isDangerousWorktreeRemovalPath(
        '/srv/homes/alice/wt/feature',
        '//nas/share/repo',
        executionHostRemovalHome('/srv/homes/alice')
      )
    ).toBe(false)
  })
})

describe('canSafelyRemoveOrphanedWorktreeDirectory on an execution host', () => {
  // A proven-orphan .git file is exactly the state that unlocks the recursive
  // delete, so the home guard is the only thing left standing in front of it.
  const provenOrphan = {
    statPath: makeStatPath(['C:\\Users\\bob\\.git'], ['C:\\src\\repo\\.git']),
    readPath: makeReadPath([
      ['C:\\Users\\bob\\.git', 'gitdir: C:\\src\\repo\\.git\\worktrees\\bob\n'],
      ['C:\\src\\repo\\.git\\worktrees\\bob\\gitdir', 'C:\\Users\\bob\\.git\n']
    ])
  }

  it("refuses the Windows host's home directory from a POSIX client", async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        'C:\\Users\\bob',
        'C:\\src\\repo',
        executionHostRemovalHome('C:\\Users\\bob'),
        provenOrphan.statPath,
        provenOrphan.readPath
      )
    ).resolves.toBe(false)
  })

  it("refuses the Windows host's home directory even when the host reported nothing", async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        'C:\\Users\\bob',
        'C:\\src\\repo',
        executionHostRemovalHome(null),
        provenOrphan.statPath,
        provenOrphan.readPath
      )
    ).resolves.toBe(false)
  })

  it('still removes a proven orphan under that same host home', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        'C:\\Users\\bob\\wt\\feature',
        'C:\\src\\repo',
        executionHostRemovalHome('C:\\Users\\bob'),
        makeStatPath(['C:\\Users\\bob\\wt\\feature\\.git'], ['C:\\src\\repo\\.git']),
        makeReadPath([
          [
            'C:\\Users\\bob\\wt\\feature\\.git',
            'gitdir: C:\\src\\repo\\.git\\worktrees\\feature\n'
          ],
          ['C:\\src\\repo\\.git\\worktrees\\feature\\gitdir', 'C:\\Users\\bob\\wt\\feature\\.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('refuses a proven orphan of any shape while the host home is unanswered', async () => {
    // A bare-repo dotfiles checkout puts exactly this `.git` file at the top of a home directory,
    // and `/srv/homes/alice` has no home shape to fall back on. Unanswered is not permission.
    const orphan = {
      statPath: makeStatPath(['/srv/homes/alice/.git'], ['/opt/src/repo/.git']),
      readPath: makeReadPath([
        ['/srv/homes/alice/.git', 'gitdir: /opt/src/repo/.git/worktrees/alice\n'],
        ['/opt/src/repo/.git/worktrees/alice/gitdir', '/srv/homes/alice/.git\n']
      ])
    }

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/srv/homes/alice',
        '/opt/src/repo',
        executionHostRemovalHome(null),
        orphan.statPath,
        orphan.readPath
      )
    ).resolves.toBe(false)
    // The same call with an answer that does not match still removes it, so the refusal above is
    // the missing answer and not the path.
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/srv/homes/alice',
        '/opt/src/repo',
        executionHostRemovalHome('/srv/homes/bob'),
        orphan.statPath,
        orphan.readPath
      )
    ).resolves.toBe(true)
  })
})
