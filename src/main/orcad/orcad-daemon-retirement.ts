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
import type { OrcadDaemonRetirementVerdict } from '../../shared/orcad-stop-request'

export const ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS = 5_000

export type OrcadDaemonRetirement = {
  retirement: OrcadDaemonRetirementVerdict
  liveSessions: number | null
  reason: string | null
}

/** Live sessions across every daemon generation, or `null` when any could not answer. */
export async function countLiveOrcadDaemonSessions(): Promise<number | null> {
  try {
    const sessions = await listLiveDaemonSessions()
    return sessions ? sessions.filter((session) => session.isAlive).length : null
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
  const result = await withTimeout(
    request().catch(() => ({ state: 'unverifiable' as const })),
    timeoutMs,
    { state: 'timed-out' as const }
  )
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

/** No answer within the bound is `fallback`; the caller treats it as unverifiable. */
async function withTimeout<T, F>(work: Promise<T>, timeoutMs: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
