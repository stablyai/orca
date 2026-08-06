import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { ConnectionState } from './types'
import { t } from '@/i18n/mobile-i18n'

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
const TAILSCALE_HINT = t('connectionHealth.check')

export type ConnectionVerdict =
  | { kind: 'normal'; label: string }
  | { kind: 'warning'; label: string; hint?: string } // "Can't connect"
  | {
      kind: 'unreachable'
      label: string
      reason: 'never-connected' | 'stale'
      hint?: string
    }
  | { kind: 'auth-failed'; label: string }

export function isConnectionErrorVerdict(verdict: ConnectionVerdict): boolean {
  return ['warning', 'unreachable', 'auth-failed'].includes(verdict.kind)
}

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
  nowMs?: number
}): ConnectionVerdict {
  const { state, reconnectAttempts, lastConnectedAt } = args
  const now = args.nowMs ?? Date.now()
  const hint = isTailscaleEndpoint(args.endpoint) ? TAILSCALE_HINT : undefined

  // Why: auth-failed means the desktop no longer recognizes this pairing (e.g. it
  // lost its device registry) — retrying can't fix it, only re-pairing can, so say so.
  if (state === 'auth-failed') {
    return {
      kind: 'auth-failed',
      label: t('connectionHealth.pairing')
    }
  }

  if (state === 'connected') {
    return { kind: 'normal', label: t('connectionHealth.connected') }
  }

  if (state === 'disconnected') {
    return { kind: 'normal', label: t('connectionHealth.disconnected') }
  }

  // connecting / handshaking / reconnecting from here. The gates apply to all
  // three: every redial re-enters 'connecting', and letting that revert an
  // escalated verdict to "Connecting…" hid the failure loop behind a reassuring
  // label for most of each cycle (issue #10119).
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: 'unreachable',
        label: t('connectionHealth.cannotReach'),
        reason: 'never-connected',
        hint
      }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: 'unreachable',
        label: t('connectionHealth.cannotReach'),
        reason: 'stale',
        hint
      }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return { kind: 'warning', label: t('connectionHealth.cannotConnect'), hint }
  }

  return {
    kind: 'normal',
    label:
      state === 'reconnecting'
        ? t('connectionHealth.reconnecting')
        : t('connectionHealth.connecting')
  }
}

// Why: single place that turns a verdict into display text so every screen
// renders the Tailscale hint the same way.
export function verdictDisplayLabel(verdict: ConnectionVerdict): string {
  if ((verdict.kind === 'warning' || verdict.kind === 'unreachable') && verdict.hint) {
    return `${verdict.label} — ${verdict.hint}`
  }
  return verdict.label
}
