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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fsProvider implements the readFile the orphan proof needs; nothing else on the provider is reached before the home guard refuses.
  registerSshFilesystemProvider(CONNECTION_ID, fsProvider as never)
  const context = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no window work runs: the refusal happens before any renderer notification.
    mainWindow: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store is never consulted: the home guard refuses before any persistence runs.
    store: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime stub carries the two hooks removal calls on this route.
    runtime: {
      acquireFileWatcherRemoval: async () => ({ finish: async () => {} }),
      clearOptimisticReconcileToken: () => {}
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cancellation bookkeeping is untouched on a route that refuses before it starts.
    detectedWorktreeCancellations: {} as never,
    worktreeRemovalsInFlight: new Map()
  }
  return removeUnregisteredWorktree(
    context,
    { worktreeId: 'repo-1::wt-1', force: true, allowUnverifiedPtyStop: true },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal reads only the repo id, path and connection id on this route.
    { id: 'repo-1', path: REPO_PATH, connectionId: CONNECTION_ID } as never,
    'repo-1',
    worktreePath,
    `ssh:${CONNECTION_ID}`,
    [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removed-meta fields here are the two the SSH route inspects.
    { orcaCreatedAt: 1, orcaCreationSource: 'ssh' } as never,
    undefined,
    {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trailing options bag is unread: every value it could carry applies after the guard.
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

  it('refuses a proven orphan when the host never reported a home', async () => {
    // The orphan proof is complete and the path looks ordinary; the only thing missing is the
    // host's answer. `unverifiable` leaves the directory in place rather than deleting it.
    setWorktreeRemovalSshHostHomeResolver(() => null)
    const worktreePath = `${HOST_HOME}/workspaces/leftover`
    const fsProvider = provenOrphanFilesystem(worktreePath)

    await expect(removeOverSsh(worktreePath, fsProvider)).rejects.toThrow(
      `Refusing to delete unregistered worktree path: ${worktreePath}`
    )
    expect(fsProvider.deletePath).not.toHaveBeenCalled()
  })
})
