// Apply routed-partition commands first while carrying in-memory editor views through saved-session loads.

import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutEffects
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import {
  keepPartitionEditorViews,
  partitionEditorViewsOf
} from '../loading-store/layout-editor-views'
import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'
import {
  applyCommandToSession,
  type LayoutLiveContext,
  type PaneLayoutChange
} from './terminal-pane-admission'
import { writeMovedLeafProfileRecords } from './terminal-leaf-move'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import { resolveWindowPaneDetach, type WindowPaneDetachCommand } from './window-pane-detach'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'

export type LayoutCommandRun = {
  live?: LayoutLiveContext
  /** Stop replacements before writing; false preserves existing bindings. */
  stopBeforeWrite?: (ptyIds: readonly string[]) => boolean
  noteEffects?: (effects: LayoutEffects) => void
}

// Preserve quiesced WSL rows.
export function keepFrozen(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  context: TerminalTopologyCommitContext
): WorkspaceSessionState {
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? keepWslMoveFrozenSessionsForStore(session, context.getSession(hostId))
    : session
}

/** Validate all partition holders before one atomic detach write. */
export function commitWindowPaneDetach(
  hostIds: readonly ExecutionHostId[],
  command: WindowPaneDetachCommand,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const resolved = resolveWindowPaneDetach(
    context.hostIds().map((hostId) => ({ hostId, session: context.getSession(hostId) })),
    hostIds,
    command
  )
  if (resolved && 'code' in resolved) {
    return { value: { ok: false, code: resolved.code }, persist: false }
  }
  const committed = commitLayoutCommand(hostIds, resolved?.command ?? command, context)
  if (!resolved || !committed.value.ok || committed.persist === false) {
    return committed
  }
  const restores = writeMovedLeafProfileRecords(
    {
      worktreeId: command.workspace,
      sourceTabId: resolved.sourceEntityId,
      targetTabId: resolved.command.windowDetach.tabId,
      leafId: command.leafId,
      ptyId: resolved.command.windowDetach.ptyId
    },
    context
  )
  return {
    value: committed.value,
    rollback: () => {
      restores.forEach((restore) => restore())
      committed.rollback?.()
    }
  }
}

export function commitLayoutCommand(
  hostIds: readonly ExecutionHostId[],
  command: LayoutCommand,
  context: TerminalTopologyCommitContext,
  run: LayoutCommandRun = {}
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const changes = hostIds.map((hostId) => changeIn(hostId, command, context, run.live))
  const routed = changes[0]?.change.value
  if (!routed) {
    return { value: { ok: false, code: 'workspace_not_found' }, persist: false }
  }
  const effects = routed.ok ? changes[0]!.change.effects : undefined
  // Stop first so refusal retains the pane; failed writes restore bindings for the next spawn to replace.
  if (effects?.stopPtyIds.length && run.stopBeforeWrite?.(effects.stopPtyIds) === false) {
    return { value: { ok: false, code: 'pane_already_bound' }, persist: false }
  }
  if (effects) {
    run.noteEffects?.(effects)
  }
  return written(routed, routed.ok ? changes.filter(({ change }) => change.value.ok) : [], context)
}

/** Any partition refusal prevents the whole write. */
export function commitLayoutCommandsAcrossPartitions(
  batches: readonly { hostId: ExecutionHostId; command: LayoutCommand }[],
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const changes = batches.map(({ hostId, command }) => changeIn(hostId, command, context))
  const refused = changes.find(({ change }) => !change.value.ok)?.change.value
  const first = changes[0]?.change.value
  if (refused || !first) {
    return { value: refused ?? { ok: false, code: 'workspace_not_found' }, persist: false }
  }
  return written(first, changes, context)
}

type PartitionChange = { hostId: ExecutionHostId; change: PaneLayoutChange<LayoutApplyOutcome> }

function changeIn(
  hostId: ExecutionHostId,
  command: LayoutCommand,
  context: TerminalTopologyCommitContext,
  live?: LayoutLiveContext
): PartitionChange {
  const { editorViews } = context
  return {
    hostId,
    change: applyCommandToSession(
      hostId,
      context.getSession(hostId),
      command,
      editorViews && partitionEditorViewsOf(editorViews, hostId),
      live
    )
  }
}

/** Sessions and in-memory views roll back together. */
function written(
  value: LayoutApplyOutcome,
  applied: readonly PartitionChange[],
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const { editorViews } = context
  // View-only changes still need publication even without a durable session write.
  const viewRestores = applied.flatMap(({ hostId, change }) =>
    editorViews && change.views ? [keepPartitionEditorViews(editorViews, hostId, change.views)] : []
  )
  const sessionRestores = applied.flatMap(({ hostId, change }) =>
    change.session
      ? [
          writeRestorable(
            () => context.getSession(hostId),
            (next) =>
              context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, next)),
            keepFrozen(hostId, change.session, context)
          )
        ]
      : []
  )
  if (sessionRestores.length === 0) {
    return { value, persist: false }
  }
  const restores = [...viewRestores, ...sessionRestores]
  return { value, rollback: () => restores.forEach((restore) => restore()) }
}
