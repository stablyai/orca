// The runtime continues what the last run cut off, once per start, so a desktop, a headless server and
// a paired server each act under their own setting and no window has to be open for it.

import type { StructuredAgentSessionRestartResume } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionResumeCandidate } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'
import { previousAgentSessionRuntimeStartedAt } from '../records/agent-session-runtime-end-record'
import { agentSessionRuntimeIncarnation } from '../records/agent-session-runtime-attribution'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  listProviderRelaysAtLaunch,
  liveProviderRelayChats,
  providerRelayChatsIdleStoppedThisRun
} from '../../../provider-relay/app-provider-relays'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { KeptAgentRebind } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-kept-agent'

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
   *  chats first). Whatever the setting, as the restart offer shows them. */
  cutByLastRun: ReadonlySet<string>
  /** Whether this start continued on its own. Off, every cut waits for the person, and only a
   *  dismissal tells a coordinator. */
  automatic: boolean
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
  previousRunStartedAt: () => Promise<number | undefined>
  resumeWorkOnRestart: () => boolean
  /** Chats whose agent the terminal host kept running; they were never cut and reattach live. */
  keptRunning?: () => Promise<ReadonlySet<string>>
  /** Chats whose detached agent the terminal host idle-stopped after its work ended: not cut. */
  finishedWhileDetached?: () => ReadonlySet<string>
  rebindKeptAgent?: (sessionId: string) => Promise<KeptAgentRebind>
}

/** Reattaches are cheap (no agent starts), but a burst of them still shares the startup. */
const KEPT_REBIND_CONCURRENCY = 4

export async function continueStructuredAgentSessionsAtLaunch(
  deps: StructuredAgentSessionLaunchContinuationDeps,
  onReserved: (rows: StructuredAgentSessionResumeCandidate[]) => void = () => {}
): Promise<StructuredAgentSessionLaunchContinuation> {
  const listedKept = (await deps.keptRunning?.().catch(() => null)) ?? new Set<string>()
  // Kept chats reattach before any restart offer runs; one whose agent ended meanwhile was cut
  // after all and goes through the ordinary cold path below.
  const kept = new Set<string>()
  await mapWithConcurrency([...listedKept], KEPT_REBIND_CONCURRENCY, async (sessionId) => {
    const rebound = await (
      deps.rebindKeptAgent?.(sessionId) ?? Promise.resolve('unresolved')
    ).catch((error: unknown) => {
      console.warn('[agent-session] reattaching a kept chat agent failed', error)
      return 'unresolved' as const
    })
    if (rebound !== 'gone') {
      kept.add(sessionId)
    }
  })
  const finished = deps.finishedWhileDetached?.() ?? new Set<string>()
  const heldByLastRun = deps.store
    .listHeldSessionIds()
    .filter(
      (sessionId) =>
        !kept.has(sessionId) &&
        !finished.has(sessionId) &&
        deps.store.replacedRuntime(sessionId)?.runtime !== undefined
    )
  const offers = async () => [
    ...(await deps.restartResume.list()),
    ...(await deps.restartResume.listFailures())
  ]
  const offered = new Set((await offers()).map((offer) => offer.sessionId))
  // Each chat's own owner says how its run ended: a crash, or a quit killed before it recorded its
  // offers (the chat is still held and has none). Recorded whatever the setting: with it off, the
  // person still gets the offer.
  const cuts = heldByLastRun.flatMap((sessionId) => {
    const replaced = deps.store.replacedRuntime(sessionId)
    return replaced?.runtime && (replaced.runtimeEnd === 'crash' || !offered.has(sessionId))
      ? [{ sessionId, crashedRuntime: replaced.runtime }]
      : []
  })
  if (cuts.length > 0) {
    await deps.restartResume.adoptCrashCuts(cuts, deps.startedAt)
  }
  const recordedBy = Date.now()
  // A crash offer is recorded by this start, so it is always newer than the run it read.
  const since = await deps.previousRunStartedAt()
  const cutByLastRun = async (continued: ReadonlySet<string> = new Set()) => {
    const recorded = await offers()
      .then((rows) =>
        rows.flatMap((offer) =>
          since === undefined || offer.recordedAt < since ? [] : [offer.sessionId]
        )
      )
      .catch((error: unknown) => {
        console.warn('[agent-session] reading restart offers after continuing failed', error)
        return []
      })
    return new Set([...heldByLastRun, ...recorded].filter((sessionId) => !continued.has(sessionId)))
  }
  try {
    if (!deps.resumeWorkOnRestart()) {
      return { continued: new Set(), automatic: false, cutByLastRun: await cutByLastRun() }
    }
    const answer = await deps.restartResume.continueAfterRestart(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      // Only the run that just ended cut what this start may continue on its own; with that run
      // unknown, only what this start itself recorded from a crash.
      { automatic: true, onReserved, recordedSince: since ?? deps.startedAt }
    )
    const continued = new Set(
      answer.continued.flatMap((outcome) =>
        outcome.outcome === 'continued' ? [outcome.sessionId] : []
      )
    )
    // A handoff its provider has not confirmed may already be running: not known to be cut.
    const handedOff = new Set(
      answer.continued.flatMap((outcome) =>
        outcome.outcome === 'refused' ? [] : [outcome.sessionId]
      )
    )
    return { continued, answer, automatic: true, cutByLastRun: await cutByLastRun(handedOff) }
  } finally {
    // Only this launch continues on its own what the last run cut; later launches leave it to a
    // person. A failure here must not hide what this launch already continued.
    await deps.restartResume.passOverAutomatic(recordedBy).catch((error: unknown) => {
      console.warn('[agent-session] passing over restart offers failed', error)
    })
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
        previousRunStartedAt: () =>
          previousAgentSessionRuntimeStartedAt(
            host.deps.journalDatabase.stateDirectory,
            agentSessionRuntimeIncarnation()
          ),
        resumeWorkOnRestart,
        keptRunning: async () => {
          await listProviderRelaysAtLaunch()
          return liveProviderRelayChats()
        },
        finishedWhileDetached: providerRelayChatsIdleStoppedThisRun,
        rebindKeptAgent: host.mutations.rebindKeptAgent
      }
    : undefined
}

/** One continuation per start, which callers can wait on before acting on what it left. */
export class StructuredAgentSessionLaunchContinuationOnce {
  private started = false
  private readonly settled = Promise.withResolvers<StructuredAgentSessionLaunchContinuation>()
  private readonly ran = Promise.withResolvers<StructuredAgentSessionLaunchContinuation>()
  private readonly reserved = Promise.withResolvers<StructuredAgentSessionResumeCandidate[]>()
  private answered = false
  private readonly retried = new Set<(settled: StructuredAgentSessionLaunchContinuation) => void>()
  private resolvedEmpty = false
  private retriedOutcome: StructuredAgentSessionLaunchContinuation | undefined

  get done(): Promise<StructuredAgentSessionLaunchContinuation> {
    return this.settled.promise
  }

  /** Settles once a run with a host continued, a retried restoration's included, or with nothing
   *  when this start had no host and nothing retries; a failed restoration's nothing waits. */
  get continued(): Promise<StructuredAgentSessionLaunchContinuation> {
    return this.ran.promise
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
  start(deps?: StructuredAgentSessionLaunchContinuationDeps, { retryable = false } = {}): void {
    const nothing = {
      continued: new Set<string>(),
      automatic: false,
      cutByLastRun: new Set<string>()
    }
    if (!deps) {
      this.resolvedEmpty = !this.started
      this.reserved.resolve([])
      this.settled.resolve(nothing)
      if (!retryable) {
        this.ran.resolve(nothing)
      }
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
        this.ran.resolve(settled)
        if (this.resolvedEmpty) {
          this.retriedOutcome = settled
          this.retried.forEach((listener) => listener(settled))
        }
      })
  }
}
