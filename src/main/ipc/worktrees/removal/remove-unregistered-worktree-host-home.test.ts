import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../pty', () => ({ getSshPtyProvider: () => undefined }))
vi.mock('../../worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: vi.fn(async () => {}),
  cleanupUnusedWorktreePushTargetRemoteSsh: vi.fn(async () => {}),
  notifyWorktreesChanged: vi.fn()
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('./worktree-removal-ownership', () => ({
  removeWorktreeMetadataAndTransientState: vi.fn(),
  stopPtysForDestructiveWorktreeRemoval: vi.fn(async () => {})
}))
vi.mock('./worktree-removal-filesystem', () => ({
  isAlreadyRemovedWorktreePath: vi.fn(async () => false),
  isLocalGitRepository: vi.fn(async () => false)
}))

const { removeUnregisteredWorktree } = await import('./remove-unregistered-worktree')
const { registerSshFilesystemProvider, unregisterSshFilesystemProvider } =
  await import('../../../providers/ssh-filesystem-dispatch')
const { setWorktreeRemovalSshHostHomeResolver } =
  await import('../../../worktree-removal-execution-host-route')

const CONNECTION_ID = 'ipc-host-home-target'
const HOST_HOME = '/srv/homes/alice'
const REPO_PATH = '/opt/src/repo'

/** `.git` contents proving an orphaned linked worktree — the state that unlocks the recursive delete. */
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

function removeOverSsh(
  worktreePath: string,
  fsProvider: ReturnType<typeof provenOrphanFilesystem>
) {
  registerSshFilesystemProvider(CONNECTION_ID, fsProvider as never)
  const context = {
    mainWindow: {} as never,
    store: {} as never,
    runtime: {
      acquireFileWatcherRemoval: async () => ({ finish: async () => {} }),
      clearOptimisticReconcileToken: () => {}
    } as never,
    detectedWorktreeCancellations: {} as never,
    worktreeRemovalsInFlight: new Map()
  }
  return removeUnregisteredWorktree(
    context,
    { worktreeId: 'repo-1::wt-1', force: true, allowUnverifiedPtyStop: true },
    { id: 'repo-1', path: REPO_PATH, connectionId: CONNECTION_ID } as never,
    'repo-1',
    worktreePath,
    `ssh:${CONNECTION_ID}`,
    [],
    { orcaCreatedAt: 1, orcaCreationSource: 'ssh' } as never,
    undefined,
    {},
    {} as never
  )
}

afterEach(() => {
  setWorktreeRemovalSshHostHomeResolver(() => null)
  unregisterSshFilesystemProvider(CONNECTION_ID)
})

describe('removeUnregisteredWorktree against an SSH host home', () => {
  // Pins the IPC call site to the host authority: substituting the client's home here passed
  // every other suite while letting the remote delete reach the host's own home directory.
  it("refuses to recursively delete the host's own home directory", async () => {
    setWorktreeRemovalSshHostHomeResolver(() => HOST_HOME)
    const fsProvider = provenOrphanFilesystem(HOST_HOME)

    await expect(removeOverSsh(HOST_HOME, fsProvider)).rejects.toThrow(
      `Refusing to delete unregistered worktree path: ${HOST_HOME}`
    )
    expect(fsProvider.deletePath).not.toHaveBeenCalled()
  })

  it('still deletes a proven orphan under that host home', async () => {
    setWorktreeRemovalSshHostHomeResolver(() => HOST_HOME)
    const worktreePath = `${HOST_HOME}/workspaces/leftover`
    const fsProvider = provenOrphanFilesystem(worktreePath)

    await removeOverSsh(worktreePath, fsProvider)

    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
  })
})
