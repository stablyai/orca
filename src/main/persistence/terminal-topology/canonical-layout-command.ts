import { isDeepStrictEqual } from 'node:util'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { surfaceLayoutOutcome } from '../../workspace-surfaces/surface-layout-outcome'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutEffects
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { SessionHostPartitionOperations } from '../loading-store/session-host-partitions'
import type { WorkspaceSurfaceCommands } from '../loading-store/workspace-surface-commands'
import type { LayoutLiveContext } from './terminal-pane-admission'
import { applyCommandToSession } from './terminal-pane-admission'
import { captureSurfaceLayoutCommand } from '../../workspace-surfaces/surface-layout-request'
import {
  keepPartitionEditorViews,
  partitionEditorViewsOf
} from '../loading-store/layout-editor-views'

export function changesSurfaceContent(command: LayoutCommand): boolean {
  return (
    [
      'createTerminalTab',
      'splitPane',
      'closePane',
      'closeTabs',
      'movePane',
      'movePaneToNewTab',
      'releasePaneTerminal',
      'setChatPane',
      'openAgentSessionTab',
      'startPane',
      'restartPane',
      'sleep',
      'wake',
      'applyDefaultTabs',
      'moveTabToWorkspace'
    ].includes(command.type) ||
    (command.type === 'setTabProps' && command.clearLaunchAgent === true)
  )
}

export async function applyCanonicalLayoutCommand(
  context: {
    runtime: Pick<
      StoreRuntimeState,
      'workspaceSurfaces' | 'layoutEditorViews' | 'ptyBindingGenerations'
    >
    sessions: SessionHostPartitionOperations
    surfaces: WorkspaceSurfaceCommands
  },
  command: LayoutCommand,
  hostIds: readonly ExecutionHostId[],
  run: {
    admit?: (partitions?: readonly WorkspaceSessionState[]) => boolean
    live?: LayoutLiveContext
    stopBeforeWrite?: (ptyIds: readonly string[]) => boolean
    onEffects?: (effects: LayoutEffects) => void
  }
): Promise<LayoutApplyOutcome> {
  const owners = hostIds.filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
  const legacy = new Map(
    owners
      .filter((hostId) => !context.runtime.workspaceSurfaces!.initialized(hostId))
      .map(
        (hostId) => [hostId, structuredClone(context.sessions.getWorkspaceSession(hostId))] as const
      )
  )
  const captured = new Map(
    owners
      .filter((hostId) => !legacy.has(hostId))
      .map((hostId) => [
        hostId,
        captureSurfaceLayoutCommand(
          context.runtime.workspaceSurfaces!,
          hostId,
          context.sessions.getWorkspaceSession(hostId),
          command,
          run.live
        )
      ])
  )
  for (const hostId of legacy.keys()) {
    await context.surfaces.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId })
  }
  for (const [hostId, previous] of legacy) {
    const current = context.sessions.getWorkspaceSession(hostId)
    if (!isDeepStrictEqual(terminalOwnerState(previous), terminalOwnerState(current))) {
      return { ok: false, code: 'tab_not_found' }
    }
    captured.set(
      hostId,
      captureSurfaceLayoutCommand(
        context.runtime.workspaceSurfaces!,
        hostId,
        current,
        command,
        run.live
      )
    )
  }
  let refused: LayoutApplyOutcome = { ok: false, code: 'workspace_not_found' }
  const views = new Map<ExecutionHostId, ReturnType<typeof applyCommandToSession>['views']>()
  const results = await context.surfaces.executeWorkspaceSurfaceTransaction(() => {
    const partitions = owners.map((hostId) => context.sessions.getWorkspaceSession(hostId))
    if (run.admit && !run.admit(partitions)) {
      refused = { ok: false, code: 'tab_not_found' }
      return []
    }
    const changes = owners.map((hostId, index) => {
      const session = partitions[index]!
      const normalized = captured.get(hostId)!.request.command
      const change = applyCommandToSession(
        hostId,
        session,
        normalized,
        partitionEditorViewsOf(context.runtime, hostId),
        run.live
      )
      views.set(hostId, change.views)
      return { hostId, session, change, normalized }
    })
    const failure = changes.find(({ change }) => !change.value.ok)?.change
    if (changes.length === 0 || failure) {
      refused = failure?.value ?? refused
      return []
    }
    return changes.map(({ hostId, session }) => ({ ...captured.get(hostId)!, session }))
  })
  if (results.length === 0) {
    return refused
  }
  for (const result of results) {
    const hostId = hostIds.find((id) => id === result.hostId)!
    const outcome = result.outcome
    if (
      !outcome ||
      typeof outcome !== 'object' ||
      !('status' in outcome) ||
      outcome.status !== 'accepted' ||
      !('result' in outcome)
    ) {
      continue
    }
    const retainedViews = views.get(hostId)
    if (retainedViews) {
      keepPartitionEditorViews(context.runtime, hostId, retainedViews)
    }
  }
  const outcome = results[0]!.outcome
  if (
    outcome &&
    typeof outcome === 'object' &&
    'status' in outcome &&
    outcome.status === 'accepted' &&
    'result' in outcome
  ) {
    if (
      outcome.effects.stopPtyIds.length &&
      run.stopBeforeWrite?.(outcome.effects.stopPtyIds) === false
    ) {
      throw new Error('Previous terminal could not be stopped; retry the terminal start')
    }
    run.onEffects?.(outcome.effects)
    return { ok: true, result: outcome.result }
  }
  return surfaceLayoutOutcome(outcome)
}

/** Initialization may reshape device presentation; it cannot grant an older intent a new terminal owner. */
function terminalOwnerState(session: WorkspaceSessionState) {
  return {
    tabs: session.tabsByWorktree,
    layouts: session.terminalLayoutsByTabId,
    records: session.sleepingAgentSessionsByPaneKey,
    incarnations: session.terminalPtyIncarnationsByPaneKey
  }
}
