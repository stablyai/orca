import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence/loading-store/store'
import {
  runLeafOf,
  runTargetOf,
  type SurfaceRunTarget
} from '../../../shared/workspace-surfaces/surface-allocation'
import { MAX_SURFACE_COMMAND_LIFETIME_MS } from '../../workspace-surfaces/surface-command-receipts'

/** Reuse the ordinary restart reducer while preserving predecessor debt and fencing its late replies. */
export async function restartCanonicalPtyRun(
  store: Store,
  target: SurfaceRunTarget
): Promise<SurfaceRunTarget> {
  const results = await store.executeWorkspaceSurfaceTransaction(() => {
    const surface = store.readWorkspaceSurfaceFromCatalog(target)
    if (!surface || !runLeafOf(surface, target) || surface.content?.kind !== 'terminal') {
      throw new Error('terminal_pane_owner_changed')
    }
    return [
      {
        type: 'layout',
        hostId: target.hostId,
        session: store.getWorkspaceSession(target.hostId),
        facts: { startingLeafIds: [], bindings: [] },
        request: {
          hostId: target.hostId,
          callerId: 'terminal-replacement',
          commandId: randomUUID(),
          expiresAt: Date.now() + MAX_SURFACE_COMMAND_LIFETIME_MS,
          command: {
            type: 'restartPane',
            workspace: target.workspaceId,
            paneKey: `${surface.content.entityId}:${target.leafId}`
          },
          targets: [
            {
              workspaceId: target.workspaceId,
              hostTabId: target.hostTabId,
              expected: { occurrence: target.occurrence },
              leaf: {
                leafId: target.leafId,
                occurrence: target.leafOccurrence,
                runId: target.runId
              }
            }
          ]
        }
      }
    ]
  })
  const replaced = results[0]
  if (!replaced) {
    throw new Error('terminal_pane_owner_changed')
  }
  const next = replaced.host.surfaces.find(
    (row) => row.workspaceId === target.workspaceId && row.hostTabId === target.hostTabId
  )
  const outcome = replaced.outcome
  const successor = next ? runTargetOf(next, target.leafId) : null
  if (
    !successor ||
    !outcome ||
    typeof outcome !== 'object' ||
    !('status' in outcome) ||
    outcome.status !== 'accepted'
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  return successor
}
