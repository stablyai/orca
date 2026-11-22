import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RuntimeTerminalResolvePane } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { OrcaRuntimeWithResolveTerminalPane } from './resolve-terminal-pane'

export async function resolveAccountRestartPane(
  runtime: Pick<
    OrcaRuntimeWithResolveTerminalPane,
    'resolveTerminalWorkspaceLaunchScope' | 'resolveTerminalPane'
  >,
  store: RuntimeStore | null | undefined,
  paneKey: string,
  worktreeId: string | undefined,
  getPtyRecord: () =>
    | Pick<
        RuntimePtyWorktreeRecord,
        'ptyId' | 'incarnationId' | 'launchIncarnationId' | 'launchToken'
      >
    | null
    | undefined,
  restartAttemptId?: string
): Promise<RuntimeTerminalResolvePane> {
  const pane = parsePaneKey(paneKey)
  if (!pane || !worktreeId || !store?.trackPtyBindingGeneration || !store.getPtyBindingEpoch) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const workspace = await runtime.resolveTerminalWorkspaceLaunchScope(
    `id:${worktreeId}`,
    undefined,
    {
      readOnly: true
    }
  )
  const hostId = getConnectionExecutionHostId(workspace.connectionId)
  const session = store.getWorkspaceSession?.(hostId)
  const tab = session?.tabsByWorktree[workspace.id]?.find((t) => t.id === pane.tabId)
  const layout = session?.terminalLayoutsByTabId[pane.tabId]
  if (!tab || !layout || !layoutContainsLeafId(layout.root, pane.leafId)) {
    throw new Error('terminal_pane_owner_changed')
  }
  let resolved: RuntimeTerminalResolvePane | null = null
  try {
    resolved = runtime.resolveTerminalPane(paneKey, workspace.id)
  } catch (error) {
    if (!(error instanceof Error && error.message === 'terminal_not_found')) {
      throw error
    }
  }
  const bound = layout.ptyIdsByLeafId?.[pane.leafId]
  if (resolved?.connected && resolved.ptyId !== bound) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const incarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
  if (
    bound &&
    (!incarnationId ||
      (resolved?.ptyId === bound &&
        resolved.incarnationId &&
        resolved.incarnationId !== incarnationId))
  ) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const terminal: RuntimeTerminalResolvePane = resolved ?? {
    handle: '',
    tabId: pane.tabId,
    leafId: pane.leafId,
    ptyId: null,
    connected: false
  }
  const { launchToken: _launchToken, ...publicTerminal } = terminal
  const pty = restartAttemptId ? getPtyRecord() : null
  const attempt =
    pty?.ptyId === bound &&
    pty?.incarnationId &&
    pty.incarnationId === incarnationId &&
    pty.launchIncarnationId === incarnationId &&
    pty.launchToken
      ? pty.launchToken === restartAttemptId
        ? 'matching'
        : 'different'
      : undefined
  return {
    ...publicTerminal,
    accountRestart: {
      hostEpoch: store.getPtyBindingEpoch(),
      bindingGeneration: store.trackPtyBindingGeneration({
        hostId,
        tabId: pane.tabId,
        leafId: pane.leafId
      }),
      tabCreatedAt: tab.createdAt,
      owner: bound && incarnationId ? { ptyId: bound, incarnationId } : null,
      ...(attempt ? { attempt } : {})
    }
  }
}
