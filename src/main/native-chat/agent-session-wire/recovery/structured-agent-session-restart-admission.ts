import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionResumeSelection } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import type { StructuredAgentSessionRestartOfferSession } from './structured-agent-session-restart-offer-withdrawal'
import type { StructuredAgentSessionRestartCandidateReader } from './structured-agent-session-restart-candidates'
import type { StructuredAgentSessionRestartAudience } from './structured-agent-session-restart-resume-set'
import type { createRestartResumeProgress } from './structured-agent-session-restart-resume-progress'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission
} from './structured-agent-session-restart-resume-runner'
import { RestartContinuationDeferredError } from './structured-agent-session-restart-continuation'
import { restartRowsFor } from './structured-agent-session-restart-resume-set'
import {
  selectRestartAttempt,
  type RestartAttempt
} from './structured-agent-session-restart-attempt'
import { restartOfferTag } from './structured-agent-session-restart-continuation-envelope'
import { restartBodyWithRequestContext } from './structured-agent-session-restart-request-context'

/** Startup ownership is transient; the capsule and send receipts remain the durable authorities. */
export function createRestartAdmission(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'recoveryCapsule' | 'journalDatabase'>
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartOfferSession>
  enqueue: <T>(apply: () => Promise<T>) => Promise<T>
  clearWitnesses: (audience?: StructuredAgentSessionRestartAudience) => void
  revealMarkers: (markers: readonly AgentSessionResumeSelection['marker'][]) => Promise<void>
  retireSuperseded: (markers: readonly AgentSessionResumeSelection['marker'][]) => void
  derive: StructuredAgentSessionRestartCandidateReader
  deriveAtSend: StructuredAgentSessionRestartCandidateReader
  now: () => number
}) {
  const { deps, sessions, derive, deriveAtSend, revealMarkers, retireSuperseded } = input
  const admission = new StructuredAgentSessionResumeAdmission()
  const activeAttempts = new Map<string, { selection: AgentSessionResumeSelection; id: string }>()
  type Intent = {
    selection: AgentSessionResumeSelection
    abort: AbortController
    id?: string
    cancelled?: true
  }
  const selectedIntents = new Map<string, Intent>()
  const hasUnaccepted = (sessionId: string): boolean => {
    const intent = selectedIntents.get(sessionId)
    if (!intent) {
      return false
    }
    const journal = sessions.get(sessionId)?.journal
    if (intent.id && (journal?.submission(intent.id) || journal?.queuedMessages.get(intent.id))) {
      return false
    }
    const receipt = intent.id ? deps.store.readCommandReceipt({ kind: 'global' }, intent.id) : null
    return receipt?.verdict !== 'readable' || receipt.receipt.status !== 'accepted'
  }
  let stopping = false
  /** Claim only live startup capacity; pending tasks retain their durable offer. */
  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience: StructuredAgentSessionRestartAudience | undefined,
    continueOne: (selection: AgentSessionResumeSelection, attempt: RestartAttempt) => Promise<void>,
    progress: ReturnType<typeof createRestartResumeProgress>
  ) => {
    if (stopping) {
      progress.skipExcluded(sessionIds ?? [], [])
      return null
    }
    input.clearWitnesses(audience)
    const selected = await input.enqueue(
      () => deps.recoveryCapsule?.selectResume(input.now(), sessionIds) ?? Promise.resolve([])
    )
    const releaseEvidence = deps.journalDatabase.history?.pinSessions(
      selected.map((selection) => selection.marker.sessionId)
    )
    try {
      await revealMarkers(selected.map((selection) => selection.marker))
      const derived = derive(
        selected.map((selection) => selection.marker),
        'may-be-held'
      )
      retireSuperseded(derived.superseded)
      const candidates = restartRowsFor(derived.candidates, audience)
      progress.skipExcluded(sessionIds ?? [], candidates)
      if (candidates.length === 0) {
        return null
      }
      const ids = new Set(candidates.map((candidate) => candidate.sessionId))
      const selections = selected.filter((selection) => ids.has(selection.marker.sessionId))
      const bySession = new Map(
        selections.map((selection) => [selection.marker.sessionId, selection])
      )
      const discovered = deps.store.discoverTaggedSendReceipts(
        selections.map(({ marker }) => ({
          sessionId: marker.sessionId,
          tag: restartOfferTag(marker)
        }))
      )
      const attempts = new Map<string, RestartAttempt>()
      const owned = new Map<string, Intent>()
      const outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          onPhase: (sessionId, phase) => {
            if (phase === 'queued') {
              const intent: Intent = {
                selection: bySession.get(sessionId)!,
                abort: new AbortController()
              }
              selectedIntents.set(sessionId, intent)
              owned.set(sessionId, intent)
            }
            progress.set(sessionId, phase)
          },
          onFinished: (sessionId) => {
            if (selectedIntents.get(sessionId) === owned.get(sessionId)) {
              selectedIntents.delete(sessionId)
            }
          },
          prepare: async (sessionId) => {
            const journal = sessions.get(sessionId)?.journal
            const intent = owned.get(sessionId)
            if (journal && !(await journal.restartEvidenceReady(intent?.abort.signal))) {
              throw new RestartContinuationDeferredError()
            }
            if (stopping || intent?.cancelled) {
              throw new RestartContinuationDeferredError()
            }
            const selection = bySession.get(sessionId)!
            const attempt = journal
              ? selectRestartAttempt(selection, journal, discovered.get(sessionId), () =>
                  restartBodyWithRequestContext(
                    deps.journalDatabase.stateDirectory,
                    selection.marker,
                    Boolean(deps.store.getConversation(sessionId)?.location.wslDistro),
                    journal
                  )
                )
              : { kind: 'unknown' as const }
            attempts.set(sessionId, attempt)
            if (intent && attempt.kind === 'send') {
              intent.id = attempt.id
            }
          },
          onRefused: (sessionId) => progress.set(sessionId, 'refused'),
          consumeMarker: async (sessionId) => {
            const selection = bySession.get(sessionId)
            if (stopping) {
              throw new RestartContinuationDeferredError()
            }
            return (
              selection !== undefined &&
              deriveAtSend([selection.marker], 'may-be-held').candidates.length === 1
            )
          },
          resume: async (sessionId) => {
            const selection = bySession.get(sessionId)!
            const attempt = attempts.get(sessionId)!
            if (attempt.kind === 'send') {
              activeAttempts.set(sessionId, { selection, id: attempt.id })
            }
            try {
              await continueOne(selection, attempt)
            } finally {
              activeAttempts.delete(sessionId)
            }
          }
        },
        candidates,
        owner
      )
      return {
        outcomes,
        candidates,
        selections,
        attempts,
        markers: new Map(selections.map(({ marker }) => [marker.sessionId, marker]))
      }
    } finally {
      releaseEvidence?.()
    }
  }

  return {
    run,
    hasUnaccepted,
    stopping: () => stopping,
    stop: () => {
      stopping = true
      for (const intent of selectedIntents.values()) {
        intent.abort.abort()
      }
    },
    owns: (sessionId: string, id: string) => activeAttempts.get(sessionId)?.id === id,
    cancel: (sessionIds?: readonly string[], audience?: StructuredAgentSessionRestartAudience) => {
      const ids = sessionIds ? new Set(sessionIds) : null
      for (const [id, intent] of selectedIntents) {
        const record = deps.store.getConversation(id)
        if ((!ids || ids.has(id)) && (!audience || (record && audience(record.provider)))) {
          intent.cancelled = true
          intent.abort.abort()
        }
      }
    },
    cancelled: (sessionId: string) => {
      const intent = selectedIntents.get(sessionId)
      return () => intent?.cancelled === true
    }
  }
}
