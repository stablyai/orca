// Restore only from provider-authored lifecycle records; the renderer hides hydrated working rows.
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import {
  isWslHookRelayConnectionId,
  wslHookRelayDistro
} from '../../shared/wsl-hook-relay-contract'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from '../native-chat/transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../native-chat/transcript-turn-lifecycle'

/** Missing the opening record fails closed and waits for a hook. */
const LIFECYCLE_SCAN_LIMIT = 150

/** Bound WSL path translation and transcript reads behind the shared filesystem gate. */
const PASS_DEADLINE_MS = 30_000

/** Measured live boundaries were under 1h; abandoned ones began at 25h. */
const OPEN_BOUNDARY_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Keep confirmation work below the shared WSL transcript gate's pending-task budget. */
const MAX_CONCURRENT_CONFIRMATIONS = 2

export type RestoredClaudeTurnConfirmationDeps = {
  getStatusSnapshot: () => readonly AgentStatusIpcPayload[]
  isLocalExecutionHost: (worktreeId: string | undefined) => boolean
  /** Current binding, then persisted binding while the daemon session reattaches. */
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** Confirming foreground read, resolved through version-named wrappers. */
  readForegroundProcess: (ptyId: string) => Promise<string | null>
  /** Rewrites guest paths into host-readable paths and honors the pass signal. */
  toReadableTranscriptPath: (
    path: string,
    signal?: AbortSignal,
    wslDistro?: string | null
  ) => Promise<string | null>
  confirm: (paneKey: string) => boolean
  /** Cancels in-flight transcript reads; defaults to this pass's own deadline. */
  signal?: AbortSignal
  now?: () => number
  /** Newest turn boundary in a transcript's tail; defaults to the shared gated reader. */
  readTurnLifecycle?: (
    path: string,
    signal?: AbortSignal
  ) => Promise<NativeChatTurnLifecycle | undefined>
}

/** Shared fence for externally confirmed rows. Callers also enforce local workspace ownership;
 *  WSL relays are local, while SSH/remote relays remain execution-host verdicts. */
export function isRestoredWorkingClaudeTurn(row: {
  restoredUnconfirmed?: boolean
  providerSessionOnly?: boolean
  connectionId?: string | null
  state?: string
  agentType?: string | null
}): boolean {
  return (
    row.restoredUnconfirmed === true &&
    row.providerSessionOnly !== true &&
    (row.connectionId === null || isWslHookRelayConnectionId(row.connectionId)) &&
    row.state === 'working' &&
    row.agentType === 'claude'
  )
}

/** Newest provider-authored turn boundary in a Claude transcript, read through the same gated,
 *  short-read-safe tail reader Chat uses. */
export async function readClaudeTurnLifecycle(
  filePath: string,
  signal?: AbortSignal
): Promise<NativeChatTurnLifecycle | undefined> {
  const decode = nativeChatLineDecoderForAgent('claude')
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent('claude')
  if (!decode || !decodeLifecycle) {
    return undefined
  }
  const { lifecycle } = await readNativeChatTranscriptTailFile(
    filePath,
    LIFECYCLE_SCAN_LIMIT,
    decode,
    true,
    undefined,
    decodeLifecycle,
    signal
  )
  return lifecycle
}

/** A pane whose evidence held, with the PTY and binding state that evidence describes. */
type ConfirmableTurn = { paneKey: string; ptyId: string; allowUnbound: boolean }

/** Cold restore may attach an initially unbound pane to `inspected`; later detachment is stale. */
function isBindingEvidenceCurrent(
  current: string | undefined,
  inspected: string,
  allowUnbound: boolean
): boolean {
  return current === inspected || (allowUnbound && current === undefined)
}

/** Confirm only when Claude owns the pane and its provider transcript has a recent open turn.
 *  Neither proof is sufficient alone because shells outlive agents and transcripts outlive turns. */
export async function confirmRestoredWorkingClaudeTurns(
  deps: RestoredClaudeTurnConfirmationDeps
): Promise<number> {
  const readTurnLifecycle = deps.readTurnLifecycle ?? readClaudeTurnLifecycle
  const signal = deps.signal ?? AbortSignal.timeout(PASS_DEADLINE_MS)
  const now = deps.now ?? Date.now
  // Process-table scans are shared per PTY and panes reconcile concurrently.
  const foregroundByPtyId = new Map<string, Promise<string | null>>()
  const readForeground = (ptyId: string): Promise<string | null> => {
    let pending = foregroundByPtyId.get(ptyId)
    if (!pending) {
      pending = deps.readForegroundProcess(ptyId)
      foregroundByPtyId.set(ptyId, pending)
    }
    return pending
  }

  const rows = deps.getStatusSnapshot()
  const verdicts: (ConfirmableTurn | null)[] = Array.from({ length: rows.length }, () => null)
  let nextRowIndex = 0
  const inspectRow = async (row: AgentStatusIpcPayload): Promise<ConfirmableTurn | null> => {
    // One bad workspace or transcript must not strand the other panes in Promise.all.
    try {
      const transcriptPath = row.providerSession?.transcriptPath
      if (!transcriptPath || !isRestoredWorkingClaudeTurn(row)) {
        return null
      }
      const { paneKey, worktreeId } = row
      // Local absence cannot decide a remote execution host's liveness.
      if (!deps.isLocalExecutionHost(worktreeId)) {
        return null
      }
      const boundPtyId = deps.getBoundPtyIdForPaneKey(paneKey)
      const ptyId = boundPtyId ?? deps.getPersistedPtyIdForPaneKey(paneKey)
      if (!ptyId) {
        return null
      }
      let allowUnbound = boundPtyId === undefined
      const foreground = await readForeground(ptyId)
      const currentPtyId = deps.getBoundPtyIdForPaneKey(paneKey)
      // Reattach to the inspected PTY is valid; another PTY is a different session.
      if (
        !isBindingEvidenceCurrent(currentPtyId, ptyId, allowUnbound) ||
        recognizeAgentProcess(foreground)?.agent !== row.agentType
      ) {
        return null
      }
      allowUnbound = currentPtyId === undefined
      const readablePath = await deps.toReadableTranscriptPath(
        transcriptPath,
        signal,
        wslHookRelayDistro(row.connectionId)
      )
      if (readablePath === null) {
        return null
      }
      // Absence is not evidence: a quiet pane may emit no hook to correct a false spinner.
      const lifecycle = await readTurnLifecycle(readablePath, signal)
      // A fresh Claude must not confirm an abandoned transcript from an earlier session.
      const openedAt = lifecycle?.state === 'working' ? lifecycle.timestamp : null
      const age = openedAt === null ? null : now() - openedAt
      const open = age !== null && age >= 0 && age <= OPEN_BOUNDARY_MAX_AGE_MS
      return open ? { paneKey, ptyId, allowUnbound } : null
    } catch {
      // Fail closed per pane without rejecting the pass.
      return null
    }
  }
  const inspectWorker = async (): Promise<void> => {
    while (true) {
      const rowIndex = nextRowIndex++
      if (rowIndex >= rows.length) {
        return
      }
      verdicts[rowIndex] = await inspectRow(rows[rowIndex])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_CONFIRMATIONS, rows.length) }, () =>
      inspectWorker()
    )
  )

  let confirmed = 0
  for (const verdict of verdicts) {
    if (verdict === null) {
      continue
    }
    // A rebind while the transcript was read voids the gathered evidence.
    if (
      !isBindingEvidenceCurrent(
        deps.getBoundPtyIdForPaneKey(verdict.paneKey),
        verdict.ptyId,
        verdict.allowUnbound
      )
    ) {
      continue
    }
    // Why serialized: `confirm` re-reads and rewrites server state.
    if (deps.confirm(verdict.paneKey)) {
      confirmed += 1
    }
  }
  return confirmed
}
