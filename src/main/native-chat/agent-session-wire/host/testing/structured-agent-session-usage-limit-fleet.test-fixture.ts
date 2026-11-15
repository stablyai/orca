import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { usageLimitAccountSources } from '../../../../runtime/agent-session/installation/usage-limit-account-usage'

export const HOUR = 60 * 60 * 1000

/** A reading with a weekly window and, unless given, a session window with room. */
export function weekly(
  usedPercent: number,
  resetsAt: number | null,
  updatedAt: number,
  session: { usedPercent: number; resetsAt: number | null } = {
    usedPercent: 3,
    resetsAt: updatedAt + HOUR
  }
) {
  return {
    provider: 'codex',
    session: { ...session, windowMinutes: 300, resetDescription: null },
    weekly: { usedPercent, windowMinutes: 10_080, resetsAt, resetDescription: null },
    updatedAt,
    error: null,
    status: 'ok'
  } satisfies ProviderRateLimits
}

/** What the production account sources read; tests replace objects the way their owners do. */
export type FleetSources = {
  settings: Partial<GlobalSettings>
  shellEnv: Record<string, string>
  shellRevision: number
  reading: { home: string; provenance: string } | null
  limits: ProviderRateLimits | null
}

/** The production account sources over fake owners; a test replaces their objects to move them. */
export function fakeAccountSources(sources: FleetSources) {
  let suspension: { reached: () => void; gate: Promise<void> } | undefined
  const production = usageLimitAccountSources({
    rateLimits: () => ({
      usageReadingAccount: () => sources.reading,
      usageReading: () => sources.limits,
      requestUsageReading: () => true
    }),
    settings: () => sources.settings,
    shellEnvironment: async () => {
      const env = sources.shellEnv
      const suspended = suspension
      suspension = undefined
      suspended?.reached()
      await suspended?.gate
      return env
    },
    shellEnvironmentRevision: () => sources.shellRevision,
    claudeLaunchEnv: () => ({}),
    processEnvironment: {}
  })
  return {
    production,
    /** Holds the next shell-environment read open, after it took its env, until released. */
    suspendNextShellRead: () => {
      let release = () => {}
      let reached = () => {}
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      suspension = { reached, gate }
      return { reached: reachedPromise, release }
    }
  }
}
