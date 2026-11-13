import type { AccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import type { StoreRuntimeState } from '../store-runtime-state'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PersistPtyBindingArgs } from './pty-binding-request'
import { ptyBindingGenerationOf } from './pty-binding-generations'

export function accountRestartBindingIsRefused(
  runtime: Pick<StoreRuntimeState, 'workspaceMetadataCursor' | 'ptyBindingGenerations'>,
  session: WorkspaceSessionState,
  hostId: ExecutionHostId,
  args: PersistPtyBindingArgs
): boolean {
  const c = args.accountRestart
  if (!c) {
    return false
  }
  const paneKey = `${args.tabId}:${args.leafId}`
  const tab = session.tabsByWorktree[c.pane.worktreeId]?.find((t) => t.id === c.pane.tabId)
  const current = session.terminalLayoutsByTabId[c.pane.tabId]?.ptyIdsByLeafId?.[c.pane.leafId]
  const stamp = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  return (
    c.hostEpoch !== runtime.workspaceMetadataCursor.epoch ||
    c.pane.worktreeId !== args.worktreeId ||
    c.pane.tabId !== args.tabId ||
    c.pane.leafId !== args.leafId ||
    tab?.createdAt !== c.pane.tabCreatedAt ||
    ptyBindingGenerationOf(runtime, hostId, c.pane.leafId) !== c.expected.bindingGeneration ||
    (c.expected.kind === 'empty'
      ? current !== undefined
      : current !== c.expected.ptyId || stamp !== c.expected.incarnationId)
  )
}

export function accountRestartRetirementIsRefused(
  runtime: Pick<StoreRuntimeState, 'workspaceMetadataCursor' | 'ptyBindingGenerations'>,
  session: WorkspaceSessionState,
  hostId: ExecutionHostId,
  binding: Pick<PersistPtyBindingArgs, 'worktreeId' | 'tabId' | 'leafId'>,
  condition?: AccountRestartCondition
): boolean {
  return Boolean(
    condition &&
    (condition.hostEpoch !== runtime.workspaceMetadataCursor.epoch ||
      condition.pane.worktreeId !== binding.worktreeId ||
      condition.pane.tabId !== binding.tabId ||
      condition.pane.leafId !== binding.leafId ||
      ptyBindingGenerationOf(runtime, hostId, binding.leafId) !==
        condition.expected.bindingGeneration ||
      session.tabsByWorktree[binding.worktreeId]?.find((t) => t.id === binding.tabId)?.createdAt !==
        condition.pane.tabCreatedAt)
  )
}
