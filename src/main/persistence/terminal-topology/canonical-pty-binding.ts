import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSurfaceReader } from '../../../shared/workspace-surfaces/surface-reader'
import type { PersistPtyBindingArgs } from '../loading-store/pty-binding-persistence'
import type { WorkspaceSurfaceCommands } from '../loading-store/workspace-surface-commands'

/** New resources bind by their admitted run; a legacy reattach may only confirm an existing binding. */
export async function persistCanonicalPtyBinding(
  surfaces: WorkspaceSurfaceCommands,
  reader: WorkspaceSurfaceReader,
  input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs | null),
  hostId: ExecutionHostId
): Promise<boolean> {
  let unchanged = false
  const results = await surfaces.executeWorkspaceSurfaceTransaction(() => {
    const args = typeof input === 'function' ? input() : input
    if (!args) {
      return []
    }
    if (!args.surfaceRunTarget) {
      const surface = reader
        .all(hostId)
        .find(
          (candidate) =>
            candidate.workspaceId === args.worktreeId &&
            candidate.content?.kind === 'terminal' &&
            (candidate.hostTabId === args.tabId || candidate.content.entityId === args.tabId)
        )
      const leaf =
        surface?.content?.kind === 'terminal' ? surface.content.leaves[args.leafId] : undefined
      unchanged =
        leaf?.facts.ptyId === args.ptyId && leaf.facts.incarnationId === args.incarnationId
      return []
    }
    if (args.surfaceRunTarget.hostId !== hostId) {
      return []
    }
    return [
      {
        type: 'bind-run',
        hostId,
        allocationId: args.surfaceRunTarget.runId,
        resource: {
          ptyId: args.ptyId,
          ...(args.incarnationId ? { incarnationId: args.incarnationId } : {})
        }
      }
    ]
  })
  const outcome = results[0]?.outcome
  return outcome &&
    typeof outcome === 'object' &&
    'status' in outcome &&
    outcome.status === 'accepted' &&
    'allocation' in outcome
    ? outcome.allocation.decision === 'committed'
    : unchanged
}
