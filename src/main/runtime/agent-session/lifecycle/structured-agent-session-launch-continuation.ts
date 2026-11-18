// The runtime continues what the last run cut off, once per start, so a desktop, a headless server and
// a paired server each act under their own setting and no window has to be open for it.

import type { StructuredAgentSessionRestartResume } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionResumeCandidate } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'
import { previousAgentSessionRuntimeStartedAt } from '../records/agent-session-runtime-end-record'
import { agentSessionRuntimeIncarnation } from '../records/agent-session-runtime-attribution'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'

export const STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER =
  'trusted-local:launch-continuation'

type RestartContinuationAnswer = Awaited<
  ReturnType<StructuredAgentSessionRestartResume['continueAfterRestart']>
>

export type StructuredAgentSessionLaunchContinuation = {
  /** Chats whose continuation the provider took; their next turn-stop reports them as usual. */
  continued: ReadonlySet<string>
  /** The automatic action's answer, as `restartContinue` gives a client; absent when none ran. */
  answer?: RestartContinuationAnswer
  /** Chats the run that just ended cut: a crash this start adopted, or an offer it recorded. */
  cutByLastRun: ReadonlySet<string>
}

export type StructuredAgentSessionLaunchContinuationDeps = {
  restartResume: Pick<
    StructuredAgentSessionRestartResume,
    'adoptCrashCuts' | 'continueAfterRestart' | 'passOverAutomatic' | 'list' | 'listFailures'
  >
  store: Pick<AgentSessionRecordStore, 'listHeldSessionIds' | 'replacedRuntime'>
  /** When this process started: what settlement wrote since then is this start's reading of the crash. */
  startedAt: number
  /** When the run that just ended started; unknown when no earlier run left a record. */
  previousRunStartedAt: number | undefined
  resumeWorkOnRestart: () => boolean
}

export async function continueStructuredAgentSessionsAtLaunch(
  deps: StructuredAgentSessionLaunchContinuationDeps,
  onReserved: (rows: StructuredAgentSessionResumeCandidate[]) => void = () => {}
): Promise<StructuredAgentSessionLaunchContinuation> {
  // Each chat's own owner says whether its run crashed, so a crash that cut a start short is still read.
  const cuts = deps.store.listHeldSessionIds().flatMap((sessionId) => {
    const replaced = deps.store.replacedRuntime(sessionId)
    return replaced?.runtimeEnd === 'crash' && replaced.runtime
      ? [{ sessionId, crashedRuntime: replaced.runtime }]
      : []
  })
  // Recorded whatever the setting: with it off, the person still gets the offer.
  if (cuts.length > 0) {
    await deps.restartResume.adoptCrashCuts(cuts, deps.startedAt)
  }
  const recordedBy = Date.now()
  const cutByLastRun = async () => {
    const since = deps.previousRunStartedAt
    const offers = [
      ...(await deps.restartResume.list()),
      ...(await deps.restartResume.listFailures())
    ]
    return new Set([
      ...cuts.map((cut) => cut.sessionId),
      ...offers.flatMap((offer) =>
        since !== undefined && offer.recordedAt >= since ? [offer.sessionId] : []
      )
    ])
  }
  try {
    if (!deps.resumeWorkOnRestart()) {
      return { continued: new Set(), cutByLastRun: await cutByLastRun() }
    }
    const answer = await deps.restartResume.continueAfterRestart(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      { automatic: true, onReserved }
    )
    return {
      continued: new Set(
        answer.continued.flatMap((outcome) =>
          outcome.outcome === 'continued' ? [outcome.sessionId] : []
        )
      ),
      answer,
      cutByLastRun: await cutByLastRun()
    }
  } finally {
    // Only this launch continues on its own what the last run cut; later launches leave it to a person.
    await deps.restartResume.passOverAutomatic(recordedBy)
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
        startedAt: Math.trunc(performance.timeOrigin),
        previousRunStartedAt: previousAgentSessionRuntimeStartedAt(
          host.deps.journalDatabase.stateDirectory,
          agentSessionRuntimeIncarnation()
        ),
        resumeWorkOnRestart
      }
    : undefined
}

/** One continuation per start, which callers can wait on before acting on what it left. */
export class StructuredAgentSessionLaunchContinuationOnce {
  private started = false
  private readonly settled = Promise.withResolvers<StructuredAgentSessionLaunchContinuation>()
  private readonly reserved = Promise.withResolvers<StructuredAgentSessionResumeCandidate[]>()

  get done(): Promise<StructuredAgentSessionLaunchContinuation> {
    return this.settled.promise
  }

  /** The chats the automatic action took, known before any agent starts, so a window can show it. */
  get taken(): Promise<StructuredAgentSessionResumeCandidate[]> {
    return this.reserved.promise
  }

  /** Without a host (none saved, refused, or restoration failed) this start continues nothing and the
   *  offers stay for a person; waiters go on, and a restoration retried after a failure still runs it. */
  start(deps?: StructuredAgentSessionLaunchContinuationDeps): void {
    const nothing = { continued: new Set<string>(), cutByLastRun: new Set<string>() }
    if (!deps) {
      this.reserved.resolve([])
      this.settled.resolve(nothing)
      return
    }
    if (this.started) {
      return
    }
    this.started = true
    void continueStructuredAgentSessionsAtLaunch(deps, this.reserved.resolve)
      .catch((error: unknown) => {
        console.warn('[agent-session] continuing interrupted chats at launch failed', error)
        return nothing
      })
      .then((settled) => {
        // Setting off or a failure before reserving took nothing.
        this.reserved.resolve([])
        this.settled.resolve(settled)
      })
  }
}
