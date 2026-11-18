// The runtime continues what the last run cut off, once per start, so a desktop, a headless server and
// a paired server each act under their own setting and no window has to be open for it.

import type { StructuredAgentSessionRestartResume } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  readRecentAgentSessionRuntimes,
  type RecordedAgentSessionRuntime
} from '../records/agent-session-runtime-end-record'
import { agentSessionRuntimeIncarnation } from '../records/agent-session-runtime-attribution'

export const STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER =
  'trusted-local:launch-continuation'

export type StructuredAgentSessionLaunchContinuation = {
  /** Chats whose continuation the provider took; their next turn-stop reports them as usual. */
  continued: ReadonlySet<string>
}

export type StructuredAgentSessionLaunchContinuationDeps = {
  restartResume: Pick<
    StructuredAgentSessionRestartResume,
    'adoptCrashCuts' | 'continueAfterRestart'
  >
  store: Pick<AgentSessionRecordStore, 'listHeldSessionIds' | 'replacedRuntime'>
  /** Earlier runs, latest first: only the last one's crash is read back, older ones had their start. */
  recentRuns: () => Promise<RecordedAgentSessionRuntime[]>
  /** When this process started: what settlement wrote since then is this start's reading of the crash. */
  startedAt: number
  resumeWorkOnRestart: () => boolean
}

export async function continueStructuredAgentSessionsAtLaunch(
  deps: StructuredAgentSessionLaunchContinuationDeps
): Promise<StructuredAgentSessionLaunchContinuation> {
  const runs = await deps.recentRuns()
  const previous = runs[0]
  if (previous?.end === 'crash') {
    const held = deps.store
      .listHeldSessionIds()
      .filter((sessionId) => deps.store.replacedRuntime(sessionId)?.runtime === previous.runtime)
    // Recorded whatever the setting: with it off, the person still gets the offer.
    if (held.length > 0) {
      await deps.restartResume.adoptCrashCuts(held, previous.runtime, deps.startedAt)
    }
  }
  if (!deps.resumeWorkOnRestart()) {
    return { continued: new Set() }
  }
  const { continued } = await deps.restartResume.continueAfterRestart(
    undefined,
    STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
    undefined,
    {
      automatic: { runs, thisRunStartedAt: deps.startedAt }
    }
  )
  return {
    continued: new Set(
      continued.flatMap((outcome) => (outcome.outcome === 'continued' ? [outcome.sessionId] : []))
    )
  }
}

/** What an installed host continues with; no host means nothing to continue this start. */
export function structuredAgentSessionLaunchContinuationDeps(
  host: StructuredAgentSessionHost | null,
  resumeWorkOnRestart: () => boolean
): StructuredAgentSessionLaunchContinuationDeps | undefined {
  return host
    ? {
        restartResume: host.restartResume,
        store: host.deps.store,
        recentRuns: () =>
          readRecentAgentSessionRuntimes(
            host.deps.journalDatabase.stateDirectory,
            agentSessionRuntimeIncarnation()
          ),
        startedAt: Math.trunc(performance.timeOrigin),
        resumeWorkOnRestart
      }
    : undefined
}

/** One continuation per start, which callers can wait on before acting on what it left. */
export class StructuredAgentSessionLaunchContinuationOnce {
  private started = false
  private readonly settled = Promise.withResolvers<StructuredAgentSessionLaunchContinuation>()

  get done(): Promise<StructuredAgentSessionLaunchContinuation> {
    return this.settled.promise
  }

  /** Without a host (none saved, refused, or restoration failed) this start continues nothing and the
   *  offers stay for a person; waiters go on, and a restoration retried after a failure still runs it. */
  start(deps?: StructuredAgentSessionLaunchContinuationDeps): void {
    const nothing = { continued: new Set<string>() }
    if (!deps) {
      this.settled.resolve(nothing)
      return
    }
    if (this.started) {
      return
    }
    this.started = true
    void continueStructuredAgentSessionsAtLaunch(deps)
      .catch((error: unknown) => {
        console.warn('[agent-session] continuing interrupted chats at launch failed', error)
        return nothing
      })
      .then(this.settled.resolve)
  }
}
