import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import { callRuntimeRpc, RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import { installWindowVisibilityInterval } from '../../lib/window-visibility-interval'

// CR-STORAGE-007: poll cadence while the app is open.
export const CONNECTIVITY_SUMMARY_POLL_INTERVAL_MS = 30_000

// FE-TASK-STORAGE-014 (CR-STORAGE-007): per-connection health, hydrated from
// backend-go's connectivity.getSummary (channels_infra_fleet.go). Status
// union mirrors that handler's connectionHealthView.status string values
// (infrafleet.proto's ConnectionHealthEntry) verbatim — do not rename.
export type ConnectionHealthStatus = 'establishing' | 'established' | 'degraded' | 'closed'

export type ConnectionHealthEntry = {
  status: ConnectionHealthStatus
  // Millis epoch, omitted on the wire (channels_infra_fleet.go's
  // `omitempty`) when "never active"/"not currently degraded" — kept
  // optional here rather than coerced to 0, to preserve that meaning.
  lastActivityAt?: number
  degradedSince?: number
}

type ConnectivitySummaryConnection = {
  connectionId: string
  devServerId: string
  status: ConnectionHealthStatus
  lastActivityAt?: number
  degradedSince?: number
}

type ConnectivitySummaryResponse = {
  connections: ConnectivitySummaryConnection[]
}

// Why message-substring matching, not just `err.code`: a transport-level
// timeout/cold-start condition surfaces through several different signals
// depending on where the call failed (RuntimeRpcCallError.code from a
// structured envelope failure, or a plain Error/message from a client-side
// timeout race) — mirrors callRuntimeWithColdStartRetry's isRetryable check
// in remote-runtime-pty-transport.ts, the codebase's existing precedent for
// this same "is this connectivity, not application logic" distinction.
const CONNECTIVITY_LIKE_RPC_ERROR_CODES = new Set([
  'timeout',
  'not_connected',
  'agent_not_connected',
  'unreachable',
  'connection_closed',
  'relay_starting',
  'worker_cold'
])

const CONNECTIVITY_LIKE_MESSAGE_PATTERNS: RegExp[] = [
  /timed out/i,
  /\btimeout\b/i,
  /agent not connected/i,
  /relay_starting/i,
  /worker_cold/i
]

function messageLooksConnectivityRelated(message: string): boolean {
  return CONNECTIVITY_LIKE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

// Exported so callers elsewhere (and this file's own tests) can classify an
// RPC failure the same way without re-deriving the rule. Deliberately does
// NOT treat every RuntimeRpcCallError as connectivity-related — an ordinary
// backend logic error (validation, not-found, forbidden) must not trigger
// extra polling per CR-STORAGE-007's "avoid poll dư thừa cho lỗi logic
// thông thường" requirement.
export function isConnectivityLikeRpcError(err: unknown): boolean {
  if (err instanceof RuntimeRpcCallError) {
    if (CONNECTIVITY_LIKE_RPC_ERROR_CODES.has(err.code)) {
      return true
    }
    return messageLooksConnectivityRelated(err.message)
  }
  if (err instanceof Error) {
    return messageLooksConnectivityRelated(err.message)
  }
  return false
}

export type ConnectivitySlice = {
  connections: Record<string, ConnectionHealthEntry>
  // Target is caller-supplied (App-root poll trigger resolves the active
  // runtime target itself) rather than read from `get().settings` here, so
  // this slice stays independently testable without pulling in SettingsSlice.
  pollConnectivitySummary: (target: RuntimeClientTarget) => Promise<void>
  // Call from a write-RPC's catch block. Fires a best-effort connectivity
  // poll only when `err` looks transport/connectivity-related — a generic
  // application error must not trigger it (see isConnectivityLikeRpcError).
  maybeTriggerConnectivityPollAfterRpcFailure: (err: unknown, target: RuntimeClientTarget) => void
}

// CR-STORAGE-007's first 2 poll triggers (30s-while-open, foreground-return)
// bundled into one installable subscription. Reuses
// installWindowVisibilityInterval — this codebase's existing shared helper
// for exactly this "interval + re-run on becoming visible" combo (see its
// other call sites: WorktreeCard.tsx, ChecksPanel.tsx, useNow.ts) — rather
// than hand-rolling a second visibilitychange listener next to a second
// setInterval. The 3rd trigger (poll right after a connectivity-looking RPC
// write failure) is `maybeTriggerConnectivityPollAfterRpcFailure` below,
// called directly from a write-RPC call site's catch block, not from here.
export function installConnectivityPolling(args: {
  getTarget: () => RuntimeClientTarget
  pollConnectivitySummary: (target: RuntimeClientTarget) => Promise<void>
  intervalMs?: number
}): () => void {
  return installWindowVisibilityInterval({
    run: () => void args.pollConnectivitySummary(args.getTarget()),
    intervalMs: args.intervalMs ?? CONNECTIVITY_SUMMARY_POLL_INTERVAL_MS
  })
}

export const createConnectivitySlice: StateCreator<AppState, [], [], ConnectivitySlice> = (
  set,
  get
) => ({
  connections: {},

  pollConnectivitySummary: async (target) => {
    try {
      const summary = await callRuntimeRpc<ConnectivitySummaryResponse>(
        target,
        'connectivity.getSummary',
        {}
      )
      const connections: Record<string, ConnectionHealthEntry> = {}
      for (const entry of summary.connections) {
        connections[entry.connectionId] = {
          status: entry.status,
          ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
          ...(entry.degradedSince !== undefined ? { degradedSince: entry.degradedSince } : {})
        }
      }
      set({ connections })
    } catch (err) {
      // Why swallow here: this runs off an unattended 30s/visibility timer —
      // there is no UI awaiting this specific promise to reject. Leave the
      // last-known `connections` in place rather than clobbering it with {}.
      console.warn('[connectivity-status] pollConnectivitySummary failed:', err)
    }
  },

  maybeTriggerConnectivityPollAfterRpcFailure: (err, target) => {
    if (!isConnectivityLikeRpcError(err)) {
      return
    }
    void get().pollConnectivitySummary(target)
  }
})
