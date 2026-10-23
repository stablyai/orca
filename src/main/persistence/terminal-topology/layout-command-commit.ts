// A client's layout command written to the partitions holding its tab, routed partition first,
// with main's in-memory editor views carried past the saved form each partition is loaded from.

import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import {
  keepPartitionEditorViews,
  partitionEditorViewsOf
} from '../loading-store/layout-editor-views'
import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'
import { applyCommandToSession, type PaneLayoutChange } from './terminal-pane-admission'
import { writeMovedLeafProfileRecords } from './terminal-leaf-move'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import { resolveWindowPaneDetach, type WindowPaneDetachCommand } from './window-pane-detach'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'

// A paused WSL move keeps its local rows as the quiesce left them.
export function keepFrozen(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  context: TerminalTopologyCommitContext
): WorkspaceSessionState {
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? keepWslMoveFrozenSessionsForStore(session, context.getSession(hostId))
    : session
}

/** A window's drag-out: checked across every partition, then moved in each holder as one write. */
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
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const changes = hostIds.map((hostId) => changeIn(hostId, command, context))
  const routed = changes[0]?.change.value
  if (!routed) {
    return { value: { ok: false, code: 'workspace_not_found' }, persist: false }
  }
  return written(routed, routed.ok ? changes.filter(({ change }) => change.value.ok) : [], context)
}

/** Each partition's own command in one write: any refusal refuses all, and nothing is written. */
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
  context: TerminalTopologyCommitContext
): PartitionChange {
  const { editorViews } = context
  return {
    hostId,
    change: applyCommandToSession(
      hostId,
      context.getSession(hostId),
      command,
      editorViews && partitionEditorViewsOf(editorViews, hostId)
    )
  }
}

/** Writes the applied partitions' sessions and keeps their views, restored together on rollback. */
function written(
  value: LayoutApplyOutcome,
  applied: readonly PartitionChange[],
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const { editorViews } = context
  // A view-only change writes nothing durable; its partition is still re-published (writingOnly).
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
