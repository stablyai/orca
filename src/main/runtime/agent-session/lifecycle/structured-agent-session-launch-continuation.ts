// The runtime continues what the last run cut off, once per start, so a desktop, a headless server and
// a paired server each act under their own setting and no window has to be open for it.

import type { StructuredAgentSessionRestartResume } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionResumeCandidate } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'
import { otherAgentSessionRuntimeStarts } from '../records/agent-session-runtime-end-record'
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
  /** Chats the run that just ended may have cut and this start did not continue: the chats it held,
   *  which covers a cut that left no offer, and chats with an offer it recorded (a quit releases its
   *  chats first). */
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
  /** When each earlier runtime started, by runtime id; the newest is the run that just ended. */
  runtimeStarts: () => Promise<ReadonlyMap<string, number>>
  resumeWorkOnRestart: () => boolean
}

export async function continueStructuredAgentSessionsAtLaunch(
  deps: StructuredAgentSessionLaunchContinuationDeps,
  onReserved: (rows: StructuredAgentSessionResumeCandidate[]) => void = () => {}
): Promise<StructuredAgentSessionLaunchContinuation> {
  const heldByLastRun = deps.store
    .listHeldSessionIds()
    .filter((sessionId) => deps.store.replacedRuntime(sessionId)?.runtime !== undefined)
  const starts = await deps.runtimeStarts()
  const offers = async () => [
    ...(await deps.restartResume.list()),
    ...(await deps.restartResume.listFailures())
  ]
  const offered = new Set((await offers()).map((offer) => offer.sessionId))
  // Each chat's own owner says how its run ended. A crash, or a quit killed before it recorded its
  // offers (the chat is still held and has none), is read from what settlement wrote since that
  // run started. Settlement takes no hold, so after a start killed mid-adoption the next one reads
  // the same settlement again and records the same offer.
  const cuts = heldByLastRun.flatMap((sessionId) => {
    const replaced = deps.store.replacedRuntime(sessionId)
    return replaced?.runtime && (replaced.runtimeEnd === 'crash' || !offered.has(sessionId))
      ? [
          {
            sessionId,
            crashedRuntime: replaced.runtime,
            settledSince: starts.get(replaced.runtime) ?? deps.startedAt
          }
        ]
      : []
  })
  // Recorded whatever the setting: with it off, the person still gets the offer.
  if (cuts.length > 0) {
    await deps.restartResume.adoptCrashCuts(cuts)
  }
  const recordedBy = Date.now()
  const cutByLastRun = async (continued: ReadonlySet<string> = new Set()) => {
    const known = [...starts.values()]
    const since = known.length > 0 ? Math.max(...known) : undefined
    // A crash offer is recorded by this start, so it is always newer than the run it read.
    const recorded = (await offers()).flatMap((offer) =>
      since === undefined || offer.recordedAt < since ? [] : [offer.sessionId]
    )
    return new Set([...heldByLastRun, ...recorded].filter((sessionId) => !continued.has(sessionId)))
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
    const continued = new Set(
      answer.continued.flatMap((outcome) =>
        outcome.outcome === 'continued' ? [outcome.sessionId] : []
      )
    )
    return { continued, answer, cutByLastRun: await cutByLastRun(continued) }
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
        runtimeStarts: () =>
          otherAgentSessionRuntimeStarts(
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
  private answered = false
  private readonly retried = new Set<(settled: StructuredAgentSessionLaunchContinuation) => void>()
  private resolvedEmpty = false
  private retriedOutcome: StructuredAgentSessionLaunchContinuation | undefined

  get done(): Promise<StructuredAgentSessionLaunchContinuation> {
    return this.settled.promise
  }

  /** The chats the automatic action took, known before any agent starts, so a window can show it.
   *  Empty once a client was given the outcome: a reloaded or later window does not replay the run. */
  get taken(): Promise<StructuredAgentSessionResumeCandidate[]> {
    return this.answered ? Promise.resolve([]) : this.reserved.promise
  }

  /** A restoration retried after a failure settles waiters too late (they went on with nothing);
   *  its own outcome goes to these listeners instead. */
  onRetried(listener: (settled: StructuredAgentSessionLaunchContinuation) => void): void {
    this.retried.add(listener)
    if (this.retriedOutcome) {
      listener(this.retriedOutcome)
    }
  }

  /** A client has been given the settled outcome. */
  markAnswered(): void {
    this.answered = true
  }

  /** Without a host (none saved, refused, or restoration failed) this start continues nothing and the
   *  offers stay for a person; waiters go on, and a restoration retried after a failure still runs it. */
  start(deps?: StructuredAgentSessionLaunchContinuationDeps): void {
    const nothing = { continued: new Set<string>(), cutByLastRun: new Set<string>() }
    if (!deps) {
      this.resolvedEmpty = !this.started
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
        if (this.resolvedEmpty) {
          this.retriedOutcome = settled
          this.retried.forEach((listener) => listener(settled))
        }
      })
  }
}
