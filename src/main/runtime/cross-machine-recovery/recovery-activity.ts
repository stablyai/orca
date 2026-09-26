import type {
  RecoveryActivityResult,
  RecoveryPresentationWorkspaceRef,
  RecoveryWorkspaceActivity
} from '../../../shared/cross-machine-recovery-presentation-types'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import {
  newestStamp,
  presentationRefMatchesWorkspace,
  type RecoveryPresentationWorkspaceKey
} from './presentation-store'
import { getCrossMachineRecoveryPresentationStore } from './presentation-store-instance'
import type { CrossMachineRecoveryRuntime } from './recovery-export'

type RecoveryActivityRuntime = Pick<
  CrossMachineRecoveryRuntime,
  'readCrossMachineRecoveryHostState'
>

// Why: export resolves a folder workspace's views by its worktree id, so both ref kinds name a
// workspace `crossMachineRecovery.export` accepts as `id:<worktreeId>`.
function workspaceId(ref: RecoveryPresentationWorkspaceRef): string {
  return ref.kind === 'worktree' ? ref.worktreeId : ref.folderWorkspaceId
}

/** Newest human input and focus per local workspace across every retained client view. */
export async function readRecoveryActivity(
  runtime: RecoveryActivityRuntime,
  now: number
): Promise<RecoveryActivityResult> {
  const { store } = runtime.readCrossMachineRecoveryHostState()
  // Why: an SSH workspace's path names a directory on another machine, which no local capture
  // can read, and a view for an unregistered repo describes a workspace this host dropped.
  const localRepoIds = new Set(
    store
      .getRepos()
      .filter((repo) => !repo.connectionId)
      .map((repo) => repo.id)
  )
  const byWorktreeId = new Map<string, RecoveryWorkspaceActivity>()
  for (const activity of await getCrossMachineRecoveryPresentationStore().listActivity(now)) {
    const worktreeId = workspaceId(activity.workspace)
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    const current: RecoveryPresentationWorkspaceKey =
      activity.workspace.kind === 'folder'
        ? activity.workspace
        : {
            kind: 'worktree',
            worktreeId,
            instanceId: store.getWorktreeMeta(worktreeId)?.instanceId ?? null
          }
    if (
      !parsed ||
      !localRepoIds.has(parsed.repoId) ||
      !presentationRefMatchesWorkspace(activity.workspace, current)
    ) {
      continue
    }
    const previous = byWorktreeId.get(worktreeId)
    byWorktreeId.set(worktreeId, {
      worktreeId,
      path: parsed.worktreePath,
      lastHumanInputAt: newestStamp([
        previous?.lastHumanInputAt ?? null,
        activity.lastHumanInputAt
      ]),
      lastHumanFocusAt: newestStamp([previous?.lastHumanFocusAt ?? null, activity.lastHumanFocusAt])
    })
  }
  return { workspaces: [...byWorktreeId.values()] }
}
