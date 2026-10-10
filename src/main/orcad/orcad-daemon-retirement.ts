/**
 * Best-effort retirement of the terminal daemon when a managed stop asks for it.
 *
 * The daemon normally outlives orcad so terminals survive a restart (D7). Retirement happens
 * only when the daemon itself proves it owns no live session across every generation; a busy
 * or unanswering daemon stays up, and orcad's own stop never waits on that outcome.
 */
import {
  listLiveDaemonSessions,
  releaseDaemonRetirementFence,
  requestIdleDaemonRetirement
} from '../daemon/daemon-init'
import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import type { OrcadDaemonRetirementVerdict } from '../../shared/orcad-stop-request'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS } from './orcad-stop-deadlines'

export type OrcadDaemonRetirement = {
  retirement: OrcadDaemonRetirementVerdict
  liveSessions: number | null
  reason: string | null
}

/** Live sessions across every daemon generation, or `null` when any could not answer. */
export async function countLiveOrcadDaemonSessions(): Promise<number | null> {
  try {
    // The inventory lists live sessions only.
    return (await listLiveDaemonSessions())?.length ?? null
  } catch {
    return null
  }
}

type RetirementPorts = {
  request: typeof requestIdleDaemonRetirement
  releaseFence: typeof releaseDaemonRetirementFence
  countLiveSessions: typeof countLiveOrcadDaemonSessions
  timeoutMs: number
}

const DEFAULT_PORTS: RetirementPorts = {
  request: requestIdleDaemonRetirement,
  releaseFence: releaseDaemonRetirementFence,
  countLiveSessions: countLiveOrcadDaemonSessions,
  timeoutMs: ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS
}

export async function retireOrcadDaemonIfIdle(
  ports: Partial<RetirementPorts> = {}
): Promise<OrcadDaemonRetirement> {
  const { request, releaseFence, countLiveSessions, timeoutMs } = { ...DEFAULT_PORTS, ...ports }
  const attempt = request().catch(() => ({ state: 'unverifiable' as const }))
  const result = await withTimeout<DaemonIdleRetirementResult | { state: 'timed-out' }>(
    attempt,
    timeoutMs,
    { state: 'timed-out' }
  )
  if (result.state === 'timed-out') {
    // The fence cannot reopen while the attempt is pending; reopen it once a late refusal lands.
    void attempt.then((late) => late.state !== 'retiring' && releaseFence())
  }
  if (result.state === 'retiring') {
    return { retirement: 'retired', liveSessions: 0, reason: null }
  }
  // A daemon that stays must not be left refusing new terminals.
  releaseFence()
  const liveSessions =
    result.state === 'busy' && result.liveSessions !== null
      ? result.liveSessions
      : await withTimeout(countLiveSessions(), timeoutMs, null)
  if (liveSessions !== null && liveSessions > 0) {
    return {
      retirement: 'live',
      liveSessions,
      reason:
        `${liveSessions} terminal ${liveSessions === 1 ? 'session is' : 'sessions are'} still ` +
        'live, so the daemon stays up and keeps them.'
    }
  }
  return {
    retirement: 'unverifiable',
    liveSessions,
    reason:
      result.state === 'unsupported'
        ? 'The terminal daemon predates idle retirement, so it was left running.'
        : 'The host could not prove the daemon idle, so it was left running.'
  }
}
