import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { RelayHostReachability } from './relay-host-reachability'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

// Why: thresholds for escalating connection UX from neutral
// "Reconnecting…" to alarming "host appears unreachable, re-pair?".
//
// - WARNING_ATTEMPTS: 3 → label flips to "Can't connect" (existing
//   behavior). Calibrated to absorb a normal laptop wake / brief
//   network blip without alarming the user.
// - UNREACHABLE_ATTEMPTS: 12 → with the tiered 0.5s→60s backoff this
//   is ≈ 6 minutes of continuous failure (the last four attempts all
//   reuse the 60s cap). Combined with the never-connected /
//   stale-since-last-connect heuristic below, this is the trigger to
//   surface a "re-pair?" affordance. MUST stay aligned with
//   rpc-client.ts GIVE_UP_AFTER_ATTEMPTS (past which the loop slows
//   to a 90s trickle instead of parking).
// - STALE_SINCE_LAST_CONNECT_MS: 60s → if we WERE connected this
//   session but haven't been for ≥ 1 minute despite the retry loop
//   spinning, treat the same as never-connected. Catches the case
//   where the desktop's IP changed mid-session.
const WARNING_ATTEMPTS = 3
const UNREACHABLE_ATTEMPTS = 12
const STALE_SINCE_LAST_CONNECT_MS = 60_000

// Why: a repeatedly-unreachable 100.x/*.ts.net endpoint almost always means
// the phone's Tailscale tunnel is down or wedged (a known iOS failure mode
// that only a manual toggle fixes) — not that the desktop moved. Say so
// instead of leaving the user staring at a generic "Can't connect".
const TAILSCALE_HINT = 'check Tailscale'

// Label + second line per relay verdict, and the severity each one earns. No
// Tailscale hint on any of these: it would be wrong advice for a desktop that is
// reachable but asleep or signed out. The 4404 detail names sign-in because a
// signed-out desktop yields a plain 4404 once the cell no longer remembers why.
const RELAY_HOST_COPY: Record<
  Exclude<RelayHostReachability, 'connecting'>,
  { kind: 'warning' | 'unreachable'; label: (host: string) => string; detail: string }
> = {
  'signed-out': {
    kind: 'unreachable',
    label: (host) => `Sign-in required on ${host}`,
    detail: 'Sign in to Orca on your desktop to reconnect'
  },
  'host-offline': {
    kind: 'unreachable',
    label: (host) => `${host} is offline`,
    detail: "Check it's awake, Orca is running, and you're signed in"
  },
  // The cell refused this phone's relay credential (revoked, a month unused, or
  // desynced). A direct session would also rotate it, but re-pairing is the one
  // remedy that works from anywhere, so it is the only one worth printing.
  'credential-refused': {
    kind: 'unreachable',
    label: (host) => `Relay access expired for ${host}`,
    detail: 'Re-pair with your desktop'
  },
  // Amber, not red: the phone never reached the cell, which says nothing about
  // the desktop.
  unreachable: {
    kind: 'warning',
    label: () => "Can't reach Relay",
    detail: 'Check your connection'
  }
}

export type ConnectionVerdict =
  | { kind: 'normal'; label: string; hint?: string } // hint: optional iroh diagnostic
  | { kind: 'warning'; label: string; hint?: string; detail?: string } // "Can't connect"
  | {
      kind: 'unreachable'
      label: string
      reason: 'never-connected' | 'stale'
      hint?: string
      // A second line the row renders under the label; the label alone must still stand.
      detail?: string
    }
  | { kind: 'auth-failed'; label: string }

// Why: the rpc-client's lastConnectedAt is a one-shot timestamp; we have
// to recompute "are we currently stale" against now() each render.
// Centralized so home + host-detail show identical verdicts.
export function classifyConnection(args: {
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  // Optional pinned host endpoint — enables the Tailscale hint on
  // warning/unreachable verdicts. Callers without it get plain labels.
  endpoint?: string | null
  // Compact iroh diagnostic when candidate (attempting/failed/skipped).
  irohHint?: string | null
  pendingPath?: MobileConnectionPath | null
  // The desktop has repeatedly refused this device's relay credential — retrying
  // cannot fix it, so it outranks any "still connecting" reading (STA-4681).
  pairingRejected?: boolean
  // What the relay last said about the desktop: its own sign-out, or consecutive
  // identical dial failures (relay-host-reachability.ts). Ahead of the attempt
  // thresholds because it is evidence, not an inference from a failure streak,
  // and waiting twelve dials to show it wastes the whole point. 'connecting'
  // means no verdict yet.
  relayHostReachability?: RelayHostReachability
  // Names the desktop in the label ("Host 1 is offline"); the row title alone is
  // not enough on the host screen header, where the label stands by itself.
  hostName?: string
  nowMs?: number
}): ConnectionVerdict {
  const { state, reconnectAttempts, lastConnectedAt } = args
  const now = args.nowMs ?? Date.now()
  const tailscaleHint = isTailscaleEndpoint(args.endpoint) ? TAILSCALE_HINT : undefined
  const hint = mergeHints(tailscaleHint, args.irohHint)
  const host = args.hostName?.trim() || 'Host'
  const staleReason = lastConnectedAt == null ? 'never-connected' : 'stale'

  // Why: auth-failed means the desktop no longer recognizes this pairing (e.g. it
  // lost its device registry) — retrying can't fix it, only re-pairing can, so say so.
  if (state === 'auth-failed' || (args.pairingRejected && state !== 'connected')) {
    return { kind: 'auth-failed', label: 'Pairing invalid — re-pair with your desktop' }
  }

  if (state === 'connected') {
    return { kind: 'normal', label: 'Connected' }
  }

  // Below auth-failed because a revoked pairing cannot be fixed by signing in.
  // Independent of pendingPath: a refused credential clears the relay recovery
  // path, and the direct retry loop must not hide that behind "Connecting…".
  const reachability = args.relayHostReachability ?? 'connecting'
  if (reachability !== 'connecting') {
    const copy = RELAY_HOST_COPY[reachability]
    return copy.kind === 'warning'
      ? { kind: 'warning', label: copy.label(host), detail: copy.detail }
      : { kind: 'unreachable', label: copy.label(host), reason: staleReason, detail: copy.detail }
  }

  // A disconnected pending path can survive a cleared retry timer during a
  // lifecycle race. Only narrate Relay while dialing or after a retry has
  // recorded progress; otherwise the idle transport must read Disconnected.
  if (args.pendingPath === 'relay' && (state !== 'disconnected' || reconnectAttempts > 0)) {
    if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
      if (lastConnectedAt == null) {
        return { kind: 'unreachable', label: "Can't connect via Relay", reason: 'never-connected' }
      }
      if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
        return { kind: 'unreachable', label: "Can't connect via Relay", reason: 'stale' }
      }
    }
    return { kind: 'normal', label: 'Connecting via Relay…' }
  }

  if (state === 'disconnected') {
    return {
      kind: 'normal',
      label: 'Disconnected',
      ...(args.irohHint ? { hint: args.irohHint } : {})
    }
  }

  // connecting / handshaking / reconnecting from here. The gates apply to all
  // three: every redial re-enters 'connecting', and letting that revert an
  // escalated verdict to "Connecting…" hid the failure loop behind a reassuring
  // label for most of each cycle (issue #10119).
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'never-connected',
        hint
      }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'stale',
        hint
      }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return { kind: 'warning', label: "Can't connect", hint }
  }

  return {
    kind: 'normal',
    label: state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…',
    ...(args.irohHint ? { hint: args.irohHint } : {})
  }
}

function mergeHints(a?: string, b?: string | null): string | undefined {
  if (a && b) {
    return `${a}; ${b}`
  }
  return a ?? b ?? undefined
}

// Why: single place that turns a verdict into display text so every screen
// renders the Tailscale / iroh hint the same way.
export function verdictDisplayLabel(verdict: ConnectionVerdict): string {
  const hint =
    'hint' in verdict && typeof verdict.hint === 'string' && verdict.hint.length > 0
      ? verdict.hint
      : undefined
  if (
    hint &&
    (verdict.kind === 'warning' || verdict.kind === 'unreachable' || verdict.kind === 'normal')
  ) {
    // Why: iroh attempt/fail lines are useful on reconnecting, not only unreachable.
    if (verdict.kind === 'normal' && !hint.startsWith('Iroh')) {
      return verdict.label
    }
    return `${verdict.label} — ${hint}`
  }
  return verdict.label
}
