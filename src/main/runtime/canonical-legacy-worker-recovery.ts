import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../shared/execution-host'
import { worktreeIdsEqual } from '../../shared/worktree/id'
import type { RuntimeStore } from './runtime-store-contract'
import type { LegacyWorkerRecoveryResolution } from './runtime-legacy-worker-terminal-recovery-types'
import { commitCanonicalResumeRecordEdit } from './terminal/stop/canonical-resume-record-edit'

/** Admit placed edits before the legacy recovery batch acquires the profile write queue. */
export async function commitCanonicalWorkerRecovery(
  store: RuntimeStore,
  hostId: ExecutionHostId,
  { candidate, resolution }: LegacyWorkerRecoveryResolution
): Promise<void> {
  if (!store.workspaceSurfacesInitialized?.(hostId)) {
    return
  }
  const session = store.getWorkspaceSession?.(hostId)
  const record = session?.sleepingAgentSessionsByPaneKey?.[candidate.paneKey]
  const target = store.captureWorkspaceSurfaceRun?.(
    { worktreeId: candidate.worktreeId, tabId: candidate.tabId, leafId: candidate.leafId },
    hostId
  )
  const surface = store
    .readWorkspaceSurfaces?.(hostId)
    .find((row) => row.workspaceId === target?.workspaceId && row.hostTabId === target?.hostTabId)
  const leaf =
    surface?.content?.kind === 'terminal' ? surface.content.leaves[candidate.leafId] : undefined
  if (
    !target ||
    leaf?.facts.ptyId !== candidate.ptyId ||
    leaf.facts.incarnationId !== candidate.incarnationId
  ) {
    return
  }
  if (resolution === 'exited') {
    if (!store.applyLayoutCommand) {
      throw new Error('Worker recovery requires its workspace surface owner')
    }
    const outcome = await store.applyLayoutCommand(
      {
        type: 'closePane',
        workspace: candidate.worktreeId,
        tabId: candidate.tabId,
        leafId: candidate.leafId
      },
      [hostId],
      {
        admit: () =>
          isDeepStrictEqual(
            target,
            store.captureWorkspaceSurfaceRun?.(
              {
                worktreeId: candidate.worktreeId,
                tabId: candidate.tabId,
                leafId: candidate.leafId
              },
              hostId
            )
          )
      }
    )
    if (!outcome.ok) {
      throw new Error('Worker terminal changed before recovery could be saved')
    }
  }
  if (record && worktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
    await commitCanonicalResumeRecordEdit(store, hostId, (current) => {
      if (!isDeepStrictEqual(current.sleepingAgentSessionsByPaneKey?.[candidate.paneKey], record)) {
        return null
      }
      const sleeping = { ...current.sleepingAgentSessionsByPaneKey }
      delete sleeping[candidate.paneKey]
      return { ...current, sleepingAgentSessionsByPaneKey: sleeping }
    })
  }
}
