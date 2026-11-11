import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  SessionReadTerminalHistoryRequest,
  SessionReadTerminalHistoryResult
} from '../../../../shared/rpc-contract/session-terminal-history-params'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { hasClosedTerminalTabRecord } from '../../../../shared/workspace-layout/closed-terminal-tab-tombstones'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { coldRestorePayloadFromInfo } from '../../../daemon/history/restoration/cold-restore-payload-cache'
import { HistoryReader } from '../../../daemon/history/restoration/history-reader'
import { fingerprintTerminalHistorySessionAsync } from '../../../daemon/history/storage/terminal-history-recovery-quarantine'
import { deriveHeadlessLegacyTerminalLeafId } from '../surface/mobile-session-layout-projection'

type HistoryReadStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  getWorkspaceSession: (hostId: string) => WorkspaceSessionState
}
type SavedOwner = { hostId: ExecutionHostId; sessionId: string; incarnationId?: string }

function savedOwner(
  store: HistoryReadStore,
  request: SessionReadTerminalHistoryRequest
): SavedOwner | 'ambiguous' | null {
  const hosts = store.getWorkspaceSessionHostIds()
  const candidates = request.executionHostId
    ? hosts.filter((id) => id === request.executionHostId)
    : hosts
  let found: SavedOwner | null = null
  for (const hostId of candidates) {
    const session = store.getWorkspaceSession(hostId)
    const tab = session.tabsByWorktree[request.worktreeId]?.find((row) => row.id === request.tabId)
    if (
      !tab ||
      hasClosedTerminalTabRecord(
        session.closedTerminalTabTombstonesByTabId,
        request.tabId,
        request.worktreeId
      )
    ) {
      continue
    }
    const layout = session.terminalLayoutsByTabId?.[tab.id]
    const leaves = layout?.root
      ? collectLeafIds(layout.root)
      : [deriveHeadlessLegacyTerminalLeafId(tab.id)]
    if (!leaves.includes(request.leafId)) {
      continue
    }
    const sessionId =
      layout?.ptyIdsByLeafId?.[request.leafId] ?? (leaves.length === 1 ? tab.ptyId : null)
    if (!sessionId || (request.expectedSessionId && request.expectedSessionId !== sessionId)) {
      continue
    }
    const paneKey = `${request.tabId}:${request.leafId}`
    const closed = session.closedTerminalPanesByPaneKey?.[paneKey]
    const incarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (
      closed?.worktreeId === request.worktreeId &&
      closed.ptyId === sessionId &&
      closed.incarnationId === incarnationId
    ) {
      continue
    }
    if (found) {
      return 'ambiguous'
    }
    found = { hostId, sessionId, incarnationId }
  }
  return found
}

/** Saved pane ownership permits viewing output independently of whether its process can start. */
export async function readHostTerminalHistory(
  store: HistoryReadStore,
  historyPath: string,
  request: SessionReadTerminalHistoryRequest,
  signal?: AbortSignal
): Promise<SessionReadTerminalHistoryResult> {
  signal?.throwIfAborted()
  const owner = savedOwner(store, request)
  if (!owner) {
    return { status: 'absent' }
  }
  if (owner === 'ambiguous') {
    return { status: 'ambiguous' }
  }
  // A broker's SSH/mirror partition names history that belongs to another runtime.
  if (owner.hostId !== LOCAL_EXECUTION_HOST_ID || isRemoteRuntimePtyId(owner.sessionId)) {
    return { status: 'unsupported' }
  }
  try {
    const fingerprint = await fingerprintTerminalHistorySessionAsync(historyPath, owner.sessionId)
    signal?.throwIfAborted()
    if (fingerprint === null) {
      return { status: 'absent' }
    }
    const detection = await new HistoryReader(historyPath).detectColdRestoreState(owner.sessionId, {
      ignoreCleanEnd: true,
      priority: 1,
      signal
    })
    const finalFingerprint = await fingerprintTerminalHistorySessionAsync(
      historyPath,
      owner.sessionId
    )
    signal?.throwIfAborted()
    const current = savedOwner(store, request)
    if (
      !current ||
      current === 'ambiguous' ||
      current.hostId !== owner.hostId ||
      current.sessionId !== owner.sessionId ||
      current.incarnationId !== owner.incarnationId ||
      finalFingerprint !== fingerprint
    ) {
      return { status: 'changed' }
    }
    if (detection.status === 'none') {
      return { status: 'absent' }
    }
    if (detection.status === 'unreadable') {
      return { status: 'unreadable' }
    }
    const payload = coldRestorePayloadFromInfo(detection.restoreInfo)
    return payload
      ? {
          status: 'restored',
          scrollback: payload.scrollback,
          cols: payload.cols,
          rows: payload.rows,
          partial: detection.hasUnreadableRecovery
        }
      : { status: 'absent' }
  } catch {
    signal?.throwIfAborted()
    return { status: 'unreadable' }
  }
}
