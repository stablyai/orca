import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { vi } from 'vitest'
import * as gitRemoval from '../../git/worktrees/removal/worktree-removal'
import * as pushTarget from '../../ipc/worktree-remote'
import { finishRuntimeLocalWorktreeRemoval } from '../../runtime/workspaces/removal/runtime-registered-local-worktree-removal'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { prepareWorktreeRemovalsForStore } from './worktree-removal-records-load'
import { startBackgroundWorktreeRemoval } from './worktree-background-removal'

/** Hold the real successful job after Git finishes, inside its host metadata callback. */
export async function holdRemovalMetadata(
  directory: string,
  finishMetadata: () => void = () => {}
) {
  await prepareWorktreeRemovalsForStore({
    getProfileStorageDirectory: () => directory,
    getRepos: () => [{ id: 'repo' }]
  })
  vi.spyOn(gitRemoval, 'removeWorktree').mockResolvedValue({})
  vi.spyOn(pushTarget, 'cleanupUnusedWorktreePushTargetRemote').mockResolvedValue()
  let entered!: () => void
  const metadata = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const worktree = {
    path: join(directory, 'checkout'),
    branch: 'refs/heads/feature',
    head: 'abc',
    isMainWorktree: false,
    isBare: false
  }
  const result = startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: 'repo::feature',
      repoId: 'repo',
      repoPath: join(directory, 'repo'),
      worktree,
      force: false,
      deleteBranch: false
    },
    publish: () => {},
    run: (signal) =>
      finishRuntimeLocalWorktreeRemoval(
        {
          repo: {
            id: 'repo',
            path: join(directory, 'repo'),
            displayName: 'repo',
            badgeColor: '',
            addedAt: 0
          },
          target: { id: 'repo::feature' },
          removedPushTarget: undefined,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked push-target seam does not read the store; metadata completion below is real awaited I/O.
          store: {} as RuntimeStore,
          localOptions: {},
          force: false,
          deleteBranch: false,
          closeWatchers: async () => {},
          preserveBranchHead: (value) => value ?? {},
          finishRemoval: async () => {
            entered()
            await held
            await writeFile(join(directory, 'metadata-finished'), 'removed')
            finishMetadata()
          }
        },
        worktree,
        { finish: async () => {} },
        signal
      )
  })
  await metadata
  return { release, result }
}
