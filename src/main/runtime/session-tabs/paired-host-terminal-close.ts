import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { findUnifiedTerminalTabs } from '../../../shared/workspace-session-terminal-tab-close'

const PAIRED_HOST_TERMINAL_CLOSE_TIMEOUT_MS = 15_000

export type PairedHostTerminal = { environmentId: string; handle: string }

export type PairedHostTerminalCall = (
  environmentId: string,
  method: 'terminal.close' | 'terminal.closeTab',
  params: { terminal: string },
  timeoutMs: number
) => Promise<unknown>

/** The paired runtime that runs this PTY, or null when the PTY is not a paired runtime's. */
export function getPairedHostTerminal(ptyId: string | null | undefined): PairedHostTerminal | null {
  const parsed = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const environmentId = parsed?.environmentId?.trim()
  return parsed && environmentId && parsed.handle ? { environmentId, handle: parsed.handle } : null
}

function readHostClose(result: unknown): Omit<RuntimeTerminalClose, 'handle' | 'tabId'> | null {
  const close =
    typeof result === 'object' && result !== null && 'close' in result ? result.close : null
  if (typeof close !== 'object' || close === null || !('ptyKilled' in close)) {
    return null
  }
  if (typeof close.ptyKilled !== 'boolean') {
    return null
  }
  const verdict = 'ptyStopVerdict' in close ? close.ptyStopVerdict : undefined
  const reason = 'ptyStopReason' in close ? close.ptyStopReason : undefined
  return {
    ptyKilled: close.ptyKilled,
    ...(verdict === 'live' || verdict === 'unverifiable' ? { ptyStopVerdict: verdict } : {}),
    ...(typeof reason === 'string' ? { ptyStopReason: reason } : {}),
    ...('pendingKillRecorded' in close && close.pendingKillRecorded === true
      ? { pendingKillRecorded: true as const }
      : {})
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? typeof error.code === 'string'
      ? error.code
      : null
    : null
}

/** Only the owning runtime can attest a stop. Unreachable owners reject so callers retain visible mirrors for retry. */
export async function closeTerminalOnPairedHost(
  call: PairedHostTerminalCall,
  terminal: PairedHostTerminal,
  method: 'terminal.close' | 'terminal.closeTab'
): Promise<Omit<RuntimeTerminalClose, 'handle' | 'tabId'>> {
  let result: unknown
  try {
    result = await call(
      terminal.environmentId,
      method,
      { terminal: terminal.handle },
      PAIRED_HOST_TERMINAL_CLOSE_TIMEOUT_MS
    )
  } catch (error) {
    const code = errorCode(error)
    if (code === 'terminal_not_found') {
      // The owner has no such terminal, so nothing runs there to stop.
      return { ptyKilled: false }
    }
    if (code === 'terminal_handle_stale') {
      // Why not absence: a host whose renderer reloaded answers this for a PTY that still runs.
      return {
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'its owning host no longer recognizes this terminal handle'
      }
    }
    throw error
  }
  const close = readHostClose(result)
  if (!close) {
    // Why unverifiable: the owner answered, but not with a receipt this build can read.
    return {
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its owning host returned no close receipt'
    }
  }
  return close
}

/** The pin guard `closeTerminalTabInWorkspaceSession` applies, for a caller that must check first. */
export function isTerminalTabPinnedInSession(
  session: WorkspaceSessionState | null | undefined,
  tab: { worktreeId: string; tabId: string }
): boolean {
  return session
    ? session.tabsByWorktree[tab.worktreeId]?.find((row) => row.id === tab.tabId)?.isPinned ===
        true ||
        findUnifiedTerminalTabs(session, tab.worktreeId, tab.tabId).some((row) => row.isPinned)
    : false
}

type PairedHostLeaf = { tabId: string; leafId: string; ptyId: string | null }

/** Stop on the paired owner before local retirement; failure retains visibility. Null means local ownership; stillBound=false protects panes rebound/removed during the call. */
export async function closePairedHostLeafFirst(
  leaf: PairedHostLeaf,
  method: 'terminal.close' | 'terminal.closeTab',
  deps: {
    call: PairedHostTerminalCall
    /** The renderer's pin guard runs only at the local commit, after the host stopped it. */
    isTabPinned: () => boolean
    readBoundLeaf: () => PairedHostLeaf
  }
): Promise<{ close: Omit<RuntimeTerminalClose, 'handle' | 'tabId'>; stillBound: boolean } | null> {
  const terminal = getPairedHostTerminal(leaf.ptyId)
  if (!terminal) {
    return null
  }
  if (deps.isTabPinned()) {
    throw new Error('terminal_tab_pinned')
  }
  const close = await closeTerminalOnPairedHost(deps.call, terminal, method)
  let stillBound = false
  try {
    const current = deps.readBoundLeaf()
    stillBound =
      current.tabId === leaf.tabId && current.leafId === leaf.leafId && current.ptyId === leaf.ptyId
  } catch {
    // The handle no longer resolves, so there is nothing local left to retire.
  }
  return { close, stillBound }
}
