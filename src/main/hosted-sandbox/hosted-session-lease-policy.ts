// What to do next with a session-capped, no-memory-pause environment (Vercel: stop = reboot, 24h cap).
// Idle stop, the opportunistic refresh and the forced cap rollover are one decision so they never race.
import type { EnvironmentProviderCapabilities } from '../environment-providers/environment-provider-driver'
import type { HostedSessionInfo } from './hosted-environment-provider'

export type HostedActivitySample = {
  /** orcad's idle probes: clients, terminals, agents, automations. Unverifiable counts as busy. */
  verdict: 'idle' | 'busy' | 'unverifiable'
  /** Since when every probe has read idle; null while busy. */
  idleSince: number | null
  /** Last PTY input anywhere in the environment; null if none this session. */
  lastPtyInputAt: number | null
}

export type HostedLeaseWarning = 60 | 15 | 5

export type HostedLeaseAction =
  | { kind: 'none' }
  | { kind: 'renew'; extendMs: number }
  | { kind: 'warn'; minutesLeft: HostedLeaseWarning }
  | { kind: 'idle-suspend' }
  | { kind: 'rollover'; reason: 'opportunistic' | 'forced' }

export const HOSTED_LEASE_POLICY = {
  /** Renew when this much lease is left, by this much. */
  renewWhenRemainingMs: 10 * 60_000,
  renewByMs: 30 * 60_000,
  /** After this session age, roll over quietly the first time nothing is running. */
  opportunisticAfterMs: 12 * 60 * 60_000,
  ptyQuietMs: 2 * 60_000,
  /** The last tier keeps the window's toast up until the restart. */
  warnings: [60, 15, 5] as const
}

export function decideHostedLeaseAction(input: {
  now: number
  capabilities: EnvironmentProviderCapabilities
  session: HostedSessionInfo
  activity: HostedActivitySample
  warned: ReadonlySet<HostedLeaseWarning>
}): HostedLeaseAction {
  const { now, capabilities, session, activity } = input
  const idleFor =
    activity.verdict === 'idle' && activity.idleSince !== null ? now - activity.idleSince : 0
  const ptyQuiet =
    activity.lastPtyInputAt === null ||
    now - activity.lastPtyInputAt >= HOSTED_LEASE_POLICY.ptyQuietMs
  const quiet = activity.verdict === 'idle' && ptyQuiet

  if (capabilities.idleStopMs !== null && quiet && idleFor >= capabilities.idleStopMs) {
    return { kind: 'idle-suspend' }
  }
  const deadlineAt = session.deadlineAt
  if (capabilities.maxSessionMs !== null && deadlineAt !== null) {
    if (now >= deadlineAt) {
      // Nothing running: a plain suspend costs less than a reboot nobody is waiting for.
      return quiet ? { kind: 'idle-suspend' } : { kind: 'rollover', reason: 'forced' }
    }
    const minutesLeft = (deadlineAt - now) / 60_000
    for (const warning of [...HOSTED_LEASE_POLICY.warnings].sort((a, b) => a - b)) {
      if (minutesLeft <= warning && !input.warned.has(warning) && !quiet) {
        return { kind: 'warn', minutesLeft: warning }
      }
    }
    if (now - session.startedAt >= HOSTED_LEASE_POLICY.opportunisticAfterMs && quiet) {
      return { kind: 'rollover', reason: 'opportunistic' }
    }
  }
  if (
    session.leaseExpiresAt !== null &&
    session.leaseExpiresAt - now <= HOSTED_LEASE_POLICY.renewWhenRemainingMs &&
    (deadlineAt === null || session.leaseExpiresAt < deadlineAt)
  ) {
    return { kind: 'renew', extendMs: HOSTED_LEASE_POLICY.renewByMs }
  }
  return { kind: 'none' }
}
