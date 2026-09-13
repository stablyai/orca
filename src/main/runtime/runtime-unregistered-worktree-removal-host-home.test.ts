import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  resolveWorktreeRemovalRoute,
  setWorktreeRemovalSshHostHomeResolver
} from '../worktree-removal-execution-host-route'

const TARGET = 'host-home-target'
const HOST_HOME = '/srv/homes/alice'
const REPO_PATH = '/opt/src/repo'

/**
 * `.git` contents that prove an orphaned linked worktree — the state that
 * unlocks the recursive delete, leaving the home guard as the last check.
 */
function provenOrphanFilesystem(worktreePath: string) {
  const gitFile = `${worktreePath}/.git`
  const adminDir = `${REPO_PATH}/.git/worktrees/leftover`
  return {
    deletePath: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ type: 'directory' })),
    lstat: vi.fn(async (path: string) =>
      path === gitFile ? { type: 'file' } : { type: 'directory' }
    ),
    readFile: vi.fn(async (path: string) => {
      if (path === gitFile) {
        return `gitdir: ${adminDir}\n`
      }
      if (path === `${adminDir}/gitdir`) {
        return `${gitFile}\n`
      }
      throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
    })
  }
}

function removalArgs(worktreePath: string, fsProvider: ReturnType<typeof provenOrphanFilesystem>) {
  registerSshGitProvider(TARGET, {} as never)
  registerSshFilesystemProvider(TARGET, fsProvider as never)
  return {
    repo: { path: REPO_PATH } as never,
    target: { id: 'wt-1', path: worktreePath } as never,
    registeredWorktrees: [],
    removedMeta: { orcaCreatedAt: 1, orcaCreationSource: 'ssh' } as never,
    removedPushTarget: undefined,
    force: true,
    allowUnverifiedPtyStop: true,
    route: resolveWorktreeRemovalRoute(`ssh:${TARGET}`),
    localOptions: {},
    store: {} as never,
    acquireWatcherRemoval: async () => ({ finish: async () => {} }),
    stopPtys: async () => {},
    deleteHistory: async () => {},
    finishRemoval: () => {}
  }
}

afterEach(() => {
  setWorktreeRemovalSshHostHomeResolver(() => null)
  unregisterSshGitProvider(TARGET)
  unregisterSshFilesystemProvider(TARGET)
})

describe('removeRuntimeUnregisteredWorktree against an SSH host home', () => {
  it("refuses to recursively delete the host's own home directory", async () => {
    setWorktreeRemovalSshHostHomeResolver(() => HOST_HOME)
    const fsProvider = provenOrphanFilesystem(HOST_HOME)

    await expect(
      removeRuntimeUnregisteredWorktree(removalArgs(HOST_HOME, fsProvider))
    ).rejects.toThrow(`Refusing to delete unregistered worktree path: ${HOST_HOME}`)
    expect(fsProvider.deletePath).not.toHaveBeenCalled()
  })

  it('still deletes a proven orphan under that host home', async () => {
    setWorktreeRemovalSshHostHomeResolver(() => HOST_HOME)
    const worktreePath = `${HOST_HOME}/workspaces/leftover`
    const fsProvider = provenOrphanFilesystem(worktreePath)

    await removeRuntimeUnregisteredWorktree(removalArgs(worktreePath, fsProvider))

    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
  })
})
