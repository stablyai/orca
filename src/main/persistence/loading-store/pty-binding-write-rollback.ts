import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../restoring-sessions/workspace-session-write-rollback'

function restoreBindingSlot(
  original: Record<string, string> | undefined,
  staged: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
  key: string
): Record<string, string> | undefined {
  if (current?.[key] !== staged?.[key] || original?.[key] === staged?.[key]) {
    return current
  }
  const restored = { ...current }
  const previous = original?.[key]
  if (previous === undefined) {
    delete restored[key]
  } else {
    restored[key] = previous
  }
  return original === undefined && Object.keys(restored).length === 0 ? undefined : restored
}

export function rollbackFailedPtyBinding(
  original: WorkspaceSessionState,
  staged: WorkspaceSessionState,
  current: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  leafId: string
): WorkspaceSessionState {
  const tab = (session: WorkspaceSessionState) =>
    session.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  const stagedTab = tab(staged)
  const originalLayout = original.terminalLayoutsByTabId[tabId]
  const stagedLayout = staged.terminalLayoutsByTabId[tabId]
  let baseline = original
  if (
    stagedTab &&
    (!isDeepStrictEqual(tab(current), stagedTab) ||
      !isDeepStrictEqual(current.terminalLayoutsByTabId[tabId], stagedLayout))
  ) {
    // Keep edited new surfaces structurally valid, without the failed process binding.
    baseline = {
      ...original,
      tabsByWorktree: tab(original)
        ? original.tabsByWorktree
        : {
            ...original.tabsByWorktree,
            [worktreeId]: [
              ...(original.tabsByWorktree[worktreeId] ?? []),
              { ...stagedTab, ptyId: null }
            ]
          },
      terminalLayoutsByTabId:
        originalLayout || !stagedLayout
          ? original.terminalLayoutsByTabId
          : {
              ...original.terminalLayoutsByTabId,
              [tabId]: { ...stagedLayout, ptyIdsByLeafId: {} }
            }
    }
  }
  const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(baseline, staged, current)
  const layout = restored.terminalLayoutsByTabId[tabId]
  const currentRoot = current.terminalLayoutsByTabId[tabId]?.root
  return {
    ...restored,
    ...(layout
      ? {
          terminalLayoutsByTabId: {
            ...restored.terminalLayoutsByTabId,
            [tabId]: {
              ...layout,
              // A tree is one value; fieldwise rollback can mix leaf and split node shapes.
              root: isDeepStrictEqual(currentRoot, stagedLayout?.root) ? layout.root : currentRoot,
              ptyIdsByLeafId: restoreBindingSlot(
                originalLayout?.ptyIdsByLeafId,
                stagedLayout?.ptyIdsByLeafId,
                layout.ptyIdsByLeafId,
                leafId
              )
            }
          }
        }
      : {}),
    terminalPtyIncarnationsByPaneKey: restoreBindingSlot(
      original.terminalPtyIncarnationsByPaneKey,
      staged.terminalPtyIncarnationsByPaneKey,
      restored.terminalPtyIncarnationsByPaneKey,
      `${tabId}:${leafId}`
    )
  }
}
