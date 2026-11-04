import { releaseSurfaceAdmissions } from '../../workspace-surfaces/surface-admission-capture'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { SessionHostPartitionOperations } from '../loading-store/session-host-partitions'
import type { WorkspaceSurfaceCommands } from '../loading-store/workspace-surface-commands'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import { planTerminalLeafMove } from './terminal-leaf-move'
import { captureSurfaceLayoutCommand } from '../../workspace-surfaces/surface-layout-request'
import { surfaceLayoutOutcome } from '../../workspace-surfaces/surface-layout-outcome'
import {
  capturePersistedTerminalTabCopy,
  isSamePersistedTerminalTabCopy
} from '../../runtime/workspace-session-terminal-tab-retirement-identity'

/** Keep every owning partition and pane-keyed profile record behind the canonical commit. */
export async function moveCanonicalTerminalLeaf(
  runtime: Pick<StoreRuntimeState, 'workspaceSurfaces'>,
  sessions: SessionHostPartitionOperations,
  surfaces: WorkspaceSurfaceCommands,
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult> {
  const reader = runtime.workspaceSurfaces!
  const partitions = () =>
    sessions
      .getWorkspaceSessionHostIds()
      .map((hostId) => ({ hostId, session: sessions.getWorkspaceSession(hostId) }))
  const initial = planTerminalLeafMove(partitions(), request)
  if (initial.result.status !== 'moved') {
    return initial.result
  }
  const legacyCopies = new Map(
    initial.sessions
      .filter(({ hostId }) => !reader.initialized(hostId))
      .map(({ hostId }) => [
        hostId,
        capturePersistedTerminalTabCopy(
          sessions.getWorkspaceSession(hostId),
          request.worktreeId,
          request.sourceTabId
        )
      ])
  )
  const capture = (hostId: (typeof initial.sessions)[number]['hostId']) =>
    captureSurfaceLayoutCommand(
      runtime.workspaceSurfaces!,
      hostId,
      sessions.getWorkspaceSession(hostId),
      {
        type: 'movePaneToNewTab',
        workspace: request.worktreeId,
        tabId: request.sourceTabId,
        leafId: request.leafId,
        windowDetach: {
          tabId: request.targetTabId,
          ptyId:
            sessions.getWorkspaceSession(hostId).terminalLayoutsByTabId[request.sourceTabId]
              ?.ptyIdsByLeafId?.[request.leafId] ?? null
        }
      }
    )
  const captured = new Map<
    (typeof initial.sessions)[number]['hostId'],
    ReturnType<typeof capture>
  >()
  const retainedCapture = (hostId: (typeof initial.sessions)[number]['hostId']) => {
    let command = captured.get(hostId)
    if (!command) {
      command = capture(hostId)
      captured.set(hostId, command)
    }
    return command
  }
  try {
    for (const { hostId } of initial.sessions) {
      if (reader.initialized(hostId)) {
        retainedCapture(hostId)
      }
    }
    for (const hostId of legacyCopies.keys()) {
      await surfaces.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId })
    }
    let result: TerminalLeafMoveResult = { status: 'not_held' }
    const committed = await surfaces.executeWorkspaceSurfaceTransaction(() => {
      const planned = planTerminalLeafMove(partitions(), request)
      result = planned.result
      if (result.status !== 'moved') {
        return []
      }
      if (
        planned.sessions.length !== initial.sessions.length ||
        planned.sessions.some(
          ({ hostId }) =>
            !captured.has(hostId) &&
            (!legacyCopies.has(hostId) ||
              !isSamePersistedTerminalTabCopy(
                legacyCopies.get(hostId) ?? null,
                capturePersistedTerminalTabCopy(
                  sessions.getWorkspaceSession(hostId),
                  request.worktreeId,
                  request.sourceTabId
                )
              ))
        )
      ) {
        result = { status: 'refused', reason: 'pty_mismatch' }
        return []
      }
      return planned.sessions.map(({ hostId }) => ({
        ...retainedCapture(hostId),
        session: sessions.getWorkspaceSession(hostId)
      }))
    })
    for (const entry of committed) {
      const outcome = surfaceLayoutOutcome(entry.outcome)
      if (!outcome.ok) {
        return {
          status: 'refused',
          reason: outcome.code === 'last_pane' ? 'last_pane' : 'pty_mismatch'
        }
      }
    }
    return result
  } finally {
    releaseSurfaceAdmissions([...captured.values()])
  }
}
