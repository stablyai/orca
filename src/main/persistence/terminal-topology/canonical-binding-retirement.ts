import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSurfaceReader } from '../../../shared/workspace-surfaces/surface-reader'
import type { PersistPtyBindingArgs } from '../loading-store/pty-binding-persistence'
import type { WorkspaceSurfaceCommands } from '../loading-store/workspace-surface-commands'
import type { SessionHostPartitionOperations } from '../loading-store/session-host-partitions'
import { captureSurfaceLayoutCommand } from '../../workspace-surfaces/surface-layout-request'
import { surfaceLayoutOutcome } from '../../workspace-surfaces/surface-layout-outcome'

/** Observed process exit releases only that incarnation and never recreates a removed pane. */
export async function retireCanonicalPtyBinding(
  context: {
    reader: WorkspaceSurfaceReader
    surfaces: WorkspaceSurfaceCommands
    sessions: SessionHostPartitionOperations
  },
  hostId: ExecutionHostId,
  binding: Pick<PersistPtyBindingArgs, 'worktreeId' | 'tabId' | 'leafId' | 'ptyId'>,
  fence?: { incarnationId: string | undefined }
): Promise<boolean> {
  let unchanged = false
  const results = await context.surfaces.executeWorkspaceSurfaceTransaction(() => {
    const surface = context.reader
      .all(hostId)
      .find(
        (candidate) =>
          candidate.workspaceId === binding.worktreeId &&
          candidate.content?.kind === 'terminal' &&
          (candidate.hostTabId === binding.tabId || candidate.content.entityId === binding.tabId)
      )
    const leaf =
      surface?.content?.kind === 'terminal' ? surface.content.leaves[binding.leafId] : undefined
    if (!leaf?.facts.ptyId) {
      unchanged = true
      return []
    }
    if (
      leaf.facts.ptyId !== binding.ptyId ||
      (fence && leaf.facts.incarnationId !== fence.incarnationId)
    ) {
      return []
    }
    return [
      captureSurfaceLayoutCommand(
        context.reader,
        hostId,
        context.sessions.getWorkspaceSession(hostId),
        {
          type: 'releasePaneTerminal',
          workspace: binding.worktreeId,
          tabId: surface!.hostTabId,
          leafId: binding.leafId,
          ptyId: binding.ptyId
        }
      )
    ]
  })
  return results[0] ? surfaceLayoutOutcome(results[0].outcome).ok : unchanged
}
