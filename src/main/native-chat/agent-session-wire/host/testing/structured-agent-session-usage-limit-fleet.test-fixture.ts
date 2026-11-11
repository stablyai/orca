import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { hostTestRestingOptionsRecord } from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { RestartContinuationSupersededError } from '../../recovery/structured-agent-session-restart-continuation'
import { StructuredAgentSessionUsageLimitContinue } from '../../recovery/structured-agent-session-usage-limit-continue'
import {
  usageLimitAccountSources,
  type UsageLimitAccountSourceDeps
} from '../../../../runtime/agent-session/installation/usage-limit-account-usage'

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

export const FLEET_HOME = '/orca-usage-limit-fleet/home'

/** What the production account sources read; tests replace objects the way their owners do. */
export type FleetSources = {
  settings: Partial<GlobalSettings>
  shellEnv: Record<string, string>
  shellRevision: number
  reading: { home: string; provenance: string } | null
  limits: ProviderRateLimits | null
}

/** The production account sources over fake owners; a test replaces their objects to move them. */
export function fakeAccountSources(
  sources: FleetSources,
  /** A real rate-limit service in place of the fake reading owner. */
  rateLimits?: UsageLimitAccountSourceDeps['rateLimits']
) {
  let suspension: { reached: () => void; gate: Promise<void> } | undefined
  const production = usageLimitAccountSources({
    rateLimits:
      rateLimits ??
      (() => ({
        usageReadingAccount: () => sources.reading,
        usageReading: () => sources.limits,
        requestUsageReading: () => {}
      })),
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

/** The production sweep over `count` due chats sharing one launch home, attributed through the
 *  production account sources. Dispatch is answered as superseded, which spends no budget. */
export function usageLimitFleet(options: {
  count: number
  provider: 'claude' | 'codex'
  now: number
  sources: FleetSources
  /** After a send passed admission. */
  dispatching?: (id: string) => void
  rateLimits?: UsageLimitAccountSourceDeps['rateLimits']
  /** How many of the chats are shown now; all by default. */
  shown?: () => number
}) {
  const { sources } = options
  let clock = options.now
  const ids = Array.from({ length: options.count }, (_, index) => `chat-${index}`)
  const calls = { launchHome: 0, reader: 0 }
  const dispatched: string[] = []
  const { production, suspendNextShellRead } = fakeAccountSources(sources, options.rateLimits)
  const record = (id: string) => ({
    ...hostTestRestingOptionsRecord(id),
    provider: options.provider,
    accountHome: {
      variable: options.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: FLEET_HOME
    }
  })
  const sweep = new StructuredAgentSessionUsageLimitContinue({
    host: {
      logger: recordingStructuredAgentSessionLogger().logger,
      launchAccountHome: async (chat) => {
        calls.launchHome++
        return chat.accountHome
      },
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {},
        accountWitness: production.accountWitness,
        accountUsage: (provider, home) => {
          calls.reader++
          return production.accountUsage(provider, home)
        }
      },
      store: {
        hostId: 'local',
        listVisibleSessionIds: () => ids.slice(0, options.shown?.() ?? ids.length),
        isSessionTabVisible: () => true,
        cancelUsageLimitContinue: async (id) => record(id),
        getRecord: record
      }
    },
    sessions: new Map(ids.map((id) => [id, {}])),
    readSavedCut: () => null,
    readLoadedCut: (id) => ({
      turnItemId: `${id}-turn`,
      resetsAt: options.now - 60_000,
      turnEndedAt: options.now - 120_000,
      chain: 0
    }),
    serialize: (_id, run) => run(),
    send: async (params) => {
      const id = params.envelope.sessionId
      params.beforeRun?.()
      dispatched.push(id)
      options.dispatching?.(id)
      throw new RestartContinuationSupersededError()
    },
    publish: () => {},
    now: () => clock
  })
  return {
    calls,
    dispatched,
    state: (id = 'chat-0') => sweep.readState(id),
    pass: async (at: number) => {
      clock = at
      await sweep.tick()
    },
    suspendNextShellRead
  }
}
