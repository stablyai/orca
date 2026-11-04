import { randomUUID } from 'node:crypto'
import { MAX_SURFACE_COMMAND_LIFETIME_MS } from './surface-command-receipts'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  LayoutCommand,
  LayoutContext
} from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSurfaceReader } from '../../shared/workspace-surfaces/surface-reader'
import type { SurfaceTarget } from '../../shared/workspace-surfaces/surface-command'
import type { SurfaceStorageCommand } from '../../shared/workspace-surfaces/surface-storage-command'
import { surfaceLayoutTargetRequirements } from './surface-layout-targets'
import { makePaneKey } from '../../shared/stable-pane-id'
import { normalizeSurfaceLayoutCommand } from './surface-layout-aliases'
import { captureSurfaceAdmission } from './surface-admission-capture'

/** Capture occurrences before dispatch; unrelated presentation revisions cannot refuse a pane action. */
export function captureSurfaceLayoutCommand(
  reader: WorkspaceSurfaceReader,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  input: LayoutCommand,
  live: Pick<LayoutContext, 'isStarting' | 'isBindingLive' | 'retiresBinding'> = {},
  closeEvidence?: readonly WorkspaceSessionState[]
): Extract<SurfaceStorageCommand, { type: 'layout' }> {
  const surfaces = reader.workspace
    ? [
        ...reader.workspace(hostId, input.workspace),
        ...(input.type === 'moveTabToWorkspace' ? reader.workspace(hostId, input.toWorkspace) : [])
      ]
    : reader.all(hostId)
  const command = normalizeSurfaceLayoutCommand(input, surfaces)
  const { required, leaves } = surfaceLayoutTargetRequirements(
    command,
    surfaces.filter(
      (surface) =>
        surface.workspaceId === command.workspace ||
        (command.type === 'moveTabToWorkspace' && surface.workspaceId === command.toWorkspace)
    )
  )
  const targets: SurfaceTarget[] = []
  const seen = new Set<string>()
  for (const key of required) {
    const encoded = JSON.stringify([key.workspaceId, key.hostTabId])
    if (seen.has(encoded)) {
      continue
    }
    seen.add(encoded)
    const surface = reader.read({ hostId, ...key })
    const expected = surface?.content ? { occurrence: surface.occurrence } : null
    const paneTargets = leaves.filter(
      (leaf) => leaf.hostTabId === key.hostTabId && key.workspaceId === command.workspace
    )
    if (paneTargets.length === 0) {
      targets.push({ ...key, expected })
    }
    for (const pane of paneTargets) {
      const leaf =
        surface?.content?.kind === 'terminal' ? surface.content.leaves[pane.leafId] : undefined
      targets.push({
        ...key,
        expected,
        ...(leaf
          ? { leaf: { leafId: pane.leafId, occurrence: leaf.occurrence, runId: leaf.runId } }
          : {})
      })
    }
  }
  const terminalLeaves = surfaces.flatMap((surface) =>
    surface.content?.kind === 'terminal'
      ? Object.entries(surface.content.leaves).map(([leafId, leaf]) => ({
          leafId,
          leaf,
          entityId: surface.content!.kind === 'terminal' ? surface.content!.entityId : ''
        }))
      : []
  )
  const captured: Extract<SurfaceStorageCommand, { type: 'layout' }> = {
    type: 'layout',
    hostId,
    session,
    request: {
      hostId,
      callerId: 'ordinary-layout',
      commandId: randomUUID(),
      expiresAt: Date.now() + MAX_SURFACE_COMMAND_LIFETIME_MS,
      command,
      targets
    },
    facts: {
      startingLeafIds: terminalLeaves
        .filter(({ leafId }) => live.isStarting?.(leafId))
        .map(({ leafId }) => leafId),
      bindings: terminalLeaves.flatMap(({ entityId, leafId, leaf }) => {
        const ptyId = leaf.facts.ptyId
        if (!ptyId) {
          return []
        }
        const paneKey = makePaneKey(entityId, leafId)
        return [
          {
            paneKey,
            ptyId,
            live: live.isBindingLive?.(paneKey, ptyId) ?? false,
            retiring: live.retiresBinding?.(paneKey, ptyId) ?? false
          }
        ]
      })
    }
  }
  captureSurfaceAdmission(reader, captured, closeEvidence)
  return captured
}
