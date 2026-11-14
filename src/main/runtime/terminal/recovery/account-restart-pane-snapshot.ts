import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

export function resolveAccountRestartPane(
  store: RuntimeStore | null | undefined,
  paneKey: string,
  worktreeId: string | undefined,
  hostIdForTab: (worktreeId: string, tabId: string) => ExecutionHostId,
  resolve: () => RuntimeTerminalResolvePane
): RuntimeTerminalResolvePane {
  const pane = parsePaneKey(paneKey)
  if (!pane || !worktreeId || !store?.trackPtyBindingGeneration || !store.getPtyBindingEpoch) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const hostId = hostIdForTab(worktreeId, pane.tabId)
  const session = store.getWorkspaceSession?.(hostId)
  const tab = session?.tabsByWorktree[worktreeId]?.find((t) => t.id === pane.tabId)
  const layout = session?.terminalLayoutsByTabId[pane.tabId]
  if (!tab || !layout || !layoutContainsLeafId(layout.root, pane.leafId)) {
    throw new Error('terminal_pane_owner_changed')
  }
  let resolved: RuntimeTerminalResolvePane | null = null
  try {
    resolved = resolve()
  } catch (error) {
    if (!(error instanceof Error && error.message === 'terminal_not_found')) {
      throw error
    }
  }
  const bound = layout.ptyIdsByLeafId?.[pane.leafId]
  if (resolved?.connected && resolved.ptyId !== bound) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const incarnationId =
    (resolved?.ptyId === bound ? resolved?.incarnationId : undefined) ??
    session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
  if (bound && !incarnationId) {
    throw new Error('terminal_pane_owner_unverified')
  }
  return {
    ...(resolved ?? {
      handle: '',
      tabId: pane.tabId,
      leafId: pane.leafId,
      ptyId: null,
      connected: false
    }),
    accountRestart: {
      hostEpoch: store.getPtyBindingEpoch(),
      bindingGeneration: store.trackPtyBindingGeneration({ hostId, leafId: pane.leafId }),
      tabCreatedAt: tab.createdAt,
      owner: bound && incarnationId ? { ptyId: bound, incarnationId } : null
    }
  }
}

export function boundLaunchToken(
  pty: RuntimePtyWorktreeRecord | null | undefined,
  boundPtyId: string | null | undefined
): { launchToken?: string } {
  return pty &&
    pty.ptyId === boundPtyId &&
    pty.launchIncarnationId === pty.incarnationId &&
    pty.launchToken
    ? { launchToken: pty.launchToken }
    : {}
}
