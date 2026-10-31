import '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import 'node:os'
import { join } from 'node:path'
import 'node:util'
import { expect, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getDefaultSettings } from '../../shared/constants'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import '../ipc/worktrees/listing/ssh-worktree-fallback'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import '../host-tree-removal'
import * as nativeFs from '../asar-transparent-fs'
import '../git/windows-worktree-removal'
import '../git/worktree-list-reader'
import '../local-orphaned-worktree-cleanup'
import * as removalOwnership from '../ipc/worktrees/removal/worktree-removal-ownership'
import { executeWorktreeRemoval } from '../ipc/worktrees/removal/execute-worktree-removal'
import './runtime-preserved-branch-cleanup'
import './runtime-store-partial-fixture'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'
import { OrcaRuntimeWithResolveWorktreeRemovalTarget } from './workspaces/workspace-removal-target'
import {
  loadWorktreeRemovalRecords,
  _settlePendingWorktreeRemovalsForTests
} from '../worktree-background-removal'
import '../git/worktree'
import '../ipc/worktree-remote'
import '../project-runtime-git-options'
import '../worktree-removal-table'
import '../git/worktree-path-comparison'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import '../worktree-removal-listing'
import { writeWorktreeRemovalRecords } from '../worktree-removal-records'
import './runtime-interrupted-local-worktree-removal'
import type { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'

import type { GitPushTarget } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import type { WorktreeIpcContext } from '../ipc/worktrees/worktree-ipc-context'
import type { WorkspaceLifecycleQueue } from './workspaces/workspace-lifecycle-queue'
import { queueWorkspaceDelete } from './workspaces/workspace-lifecycle-commands'
import * as backgroundRemoval from '../worktree-background-removal'

export function isolateRemovalGitEnvironment(home: string): void {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      vi.stubEnv(key, undefined)
    }
  }
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
    vi.stubEnv(key, home)
  }
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'empty'))
}

export const deletionOperations = () =>
  (['rm', 'unlink', 'rmdir'] as const).map((operation) => vi.spyOn(nativeFs, operation))

export function expectNoTeardownOrDeletion(
  ...callbacks: (ReturnType<typeof vi.fn> | ReturnType<typeof deletionOperations>[number])[]
): void {
  callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled())
}

export async function orphanAdmin(worktreePath: string): Promise<void> {
  const admin = (await readFile(join(worktreePath, '.git'), 'utf8')).trim().replace(/^gitdir: /, '')
  await removeTree(admin)
  await unlink(join(worktreePath, '.git'))
  await writeFile(join(worktreePath, '.git'), `  gitdir: ${admin}\nignored second line\n`)
}

export async function recordFailedRemoval(
  recordsDir: string,
  worktreePath: string,
  repo: Repo,
  repoPath: string,
  force: boolean,
  deleteBranch = true
): Promise<void> {
  await writeWorktreeRemovalRecords(recordsDir, () => [
    {
      worktreeId: `repo-1::${worktreePath}`,
      repoId: repo.id,
      repoPath,
      worktreePath,
      branch: 'feature',
      head: '',
      deleteBranch,
      force,
      requestedAt: 1,
      failure: { message: 'held file', failedAt: 2 }
    }
  ])
  await loadWorktreeRemovalRecords(recordsDir)
}

type InterruptedRemovalFixture = {
  readonly repo: Repo
  readonly worktreePath: string
  readonly scratchDir: string
  readonly pushTarget: GitPushTarget | undefined
  readonly lifecycle: WorkspaceLifecycleQueue
}

export function createInterruptedRemovalEntries(fixture: InterruptedRemovalFixture) {
  function removalHost(
    repoGone = false,
    stopPtys = async () => {},
    teardown = () => {}
  ): Parameters<typeof interruptedLocalWorktreeRemovalJob>[1] & { store: Store } {
    const store = {
      getRepo: (id: string) => (id === fixture.repo.id && !repoGone ? fixture.repo : undefined),
      getRepos: () => (repoGone ? [] : [fixture.repo]),
      getWorktreeMeta: () => ({
        ...getProjectHostSetupWorktreeMeta([], fixture.repo),
        instanceId: 'removal-fixture',
        orcaCreatedAt: 1,
        orcaCreationSource: 'runtime',
        pushTarget: fixture.pushTarget
      }),
      getWorktreeMetaForHost: () => store.getWorktreeMeta(),
      getSettings: () => getDefaultSettings(fixture.scratchDir),
      getProjectHostSetups: () => [],
      getAllWorktreeMeta: () => ({})
    }
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal/listing paths read only the supplied store methods; the fixture owns all process/session services.
      store: store as unknown as Store,
      acquireWatcherRemoval: async (path) => {
        teardown()
        const gate = acquireWatcherRemovalGate(path)
        return { finish: async () => gate.release() }
      },
      closeWatchers: vi.fn(async () => teardown()),
      stopPtys,
      preservedBranchCleanup: { preserveHead: (result) => result ?? {}, remember: vi.fn() },
      purge: () => expect(existsSync(fixture.worktreePath)).toBe(false),
      onRemoved: () => {},
      publish: () => {}
    }
  }

  type RemovalEntry = 'desktop' | 'runtime'

  async function deleteViaEntry(
    entry: RemovalEntry,
    force: boolean,
    stop = async () => {},
    teardown = vi.fn(),
    deleteBranch?: boolean
  ): Promise<unknown> {
    const worktreeId = `repo-1::${fixture.worktreePath}`
    const host = removalHost(false, stop, teardown)
    const { store } = host
    const runtime: OrcaRuntimeWithResolveWorktreeRemovalTarget = Object.assign(
      Object.create(OrcaRuntimeWithResolveWorktreeRemovalTarget.prototype),
      {
        store,
        workspaceLifecycle: fixture.lifecycle,
        listRepos: store.getRepos,
        listTerminals: async () => ({ totalCount: 0 }),
        requireStore: () => store,
        resolveWorktreeRemovalTarget: async () => ({
          id: worktreeId,
          repoId: fixture.repo.id,
          path: fixture.worktreePath
        }),
        removeManagedWorktreeInFlight: new RuntimeWorktreeRemovalInFlight(),
        localRemovalJobHost: () => host,
        acquireFileWatcherRemoval: host.acquireWatcherRemoval,
        stopPtysForDestructiveWorktreeRemoval: stop,
        closeFileWatchersForRemoval: host.closeWatchers,
        preservedBranchCleanup: { ...host.preservedBranchCleanup, delete: vi.fn() },
        purgeRemovedWorktree: host.purge,
        clearOptimisticReconcileToken: () => {},
        publishWorktreeRemovalChange: () => {},
        notifyWorktreesChanged: () => {},
        emitWorktreeLifecycle: () => {}
      }
    )
    vi.mocked(removalOwnership.stopPtysForDestructiveWorktreeRemoval).mockImplementation(stop)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native dispatch reads only the fixture-owned context fields below.
    const context = {
      store,
      runtime,
      mainWindow: { isDestroyed: () => true }
    } as unknown as WorktreeIpcContext
    try {
      const accepted =
        entry === 'desktop'
          ? await executeWorktreeRemoval(
              context,
              { worktreeId, force },
              fixture.repo,
              fixture.repo.id,
              fixture.worktreePath,
              'local'
            )
          : await queueWorkspaceDelete(
              runtime,
              `id:${worktreeId}`,
              'local',
              { force, deleteBranch },
              (removal) =>
                runtime.removeManagedWorktree(`id:${worktreeId}`, {
                  ...removal,
                  waitForBackgroundRemoval: true
                })
            )
      return await backgroundRemoval.finishAcceptedWorktreeRemoval(accepted, worktreeId)
    } finally {
      await _settlePendingWorktreeRemovalsForTests()
    }
  }
  return { removalHost, deleteViaEntry }
}
