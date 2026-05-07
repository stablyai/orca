import type { ConnectionState } from './types'

// Why: thresholds for escalating connection UX from neutral
// "Reconnecting…" to alarming "host appears unreachable, re-pair?".
//
// - WARNING_ATTEMPTS: 3 → label flips to "Can't connect" (existing
//   behavior). Calibrated to absorb a normal laptop wake / brief
//   network blip without alarming the user.
// - UNREACHABLE_ATTEMPTS: 6 → with the 4s backoff cap that's ≈ 20s of
//   continuous failure. Combined with the never-connected /
//   stale-since-last-connect heuristic below, this is the trigger to
//   surface a "re-pair?" affordance.
// - STALE_SINCE_LAST_CONNECT_MS: 60s → if we WERE connected this
//   session but haven't been for ≥ 1 minute despite the retry loop
//   spinning, treat the same as never-connected. Catches the case
//   where the desktop's IP changed mid-session.
export const WARNING_ATTEMPTS = 3
export const UNREACHABLE_ATTEMPTS = 6
export const STALE_SINCE_LAST_CONNECT_MS = 60_000

export type ConnectionVerdict =
  | { kind: 'normal'; label: string }
  | { kind: 'warning'; label: string } // "Can't connect"
  | { kind: 'unreachable'; label: string; reason: 'never-connected' | 'stale' }
  | { kind: 'auth-failed'; label: string }

// Why: the rpc-client's lastConnectedAt is a one-shot timestamp; we have
// to recompute "are we currently stale" against now() each render.
// Centralized so home + host-detail show identical verdicts.
export function classifyConnection(args: {
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  nowMs?: number
}): ConnectionVerdict {
  const { state, reconnectAttempts, lastConnectedAt } = args
  const now = args.nowMs ?? Date.now()

  if (state === 'auth-failed') {
    return { kind: 'auth-failed', label: 'Auth failed' }
  }

  // Connected / connecting / handshaking are normal.
  if (state === 'connected') return { kind: 'normal', label: 'Connected' }
  if (state === 'connecting' || state === 'handshaking') {
    return { kind: 'normal', label: 'Connecting…' }
  }

  if (state === 'disconnected') {
    return { kind: 'normal', label: 'Disconnected' }
  }

  // state === 'reconnecting' from here.
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'never-connected'
      }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'stale'
      }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return { kind: 'warning', label: "Can't connect" }
  }

  return { kind: 'normal', label: 'Reconnecting…' }
}

// Why: the message under the banner explains what likely happened so the
// user understands why we're suggesting Re-pair. Tuned to be specific
// about IP/port without being technical (we don't want to leak
// "ws://192.168.x.y:port" unless someone is debugging).
export function unreachableHint(reason: 'never-connected' | 'stale'): string {
  return reason === 'never-connected'
    ? "Can't reach this Orca desktop. Its network address may have changed since pairing — try re-pairing from the desktop's Settings → Mobile screen."
    : 'Lost contact with the Orca desktop. If your network changed (different Wi-Fi, IP renewed, or desktop restarted), try re-pairing.'
}
