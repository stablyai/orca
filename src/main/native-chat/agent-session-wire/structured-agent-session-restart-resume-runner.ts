// Delivering the explicit restart action: the one path that turns a resumable candidate back into
// a live agent.
//
// The manual "Resume" button and the automatic setting both land here, so the two can never drift
// into different eligibility or different double-fire protection.
//
// Resume itself acquires a provider child, not a new send. The first resume-capable hold on a
// childless session
// re-acquires the provider at the cursor the record already proved — Claude's `resume` +
// `resumeSessionAt`, Codex's thread id — which is native continuation. Nothing re-sends the user's
// prompt: that is what makes an agent redo work it already finished.

import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import type { StructuredAgentSessionResumeCandidate } from './structured-agent-session-restart-resume-set'

/** Providers are expensive to start and 20-30 marked chats is an ordinary morning. Resumes go out
 *  a few at a time so a launch cannot spawn every app-server at once. */
export const STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY = 3

export const STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS =
  'agent_session_resume_already_in_progress'

export type StructuredAgentSessionResumeOutcome = {
  sessionId: string
  outcome: 'resumed' | 'refused'
  /** Refusal code; `agent_session_resume_already_in_progress` names the live owner in `owner`. */
  reason?: string
  owner?: string
}

/**
 * The refusal a second caller gets, carrying WHO holds the session.
 *
 * A named error with a typed field rather than a bag assigned onto `new Error`: the catch site then
 * recognises it by identity and reads `owner` as a string, instead of poking at an unknown value.
 */
export class StructuredAgentSessionResumeInProgressError extends Error {
  constructor(readonly owner: string) {
    super(STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS)
    this.name = 'StructuredAgentSessionResumeInProgressError'
  }
}

/** The live holder named by a refusal, or null for any other failure. */
function resumeAdmissionOwner(error: unknown): string | null {
  return error instanceof StructuredAgentSessionResumeInProgressError ? error.owner : null
}

/**
 * One resume per session at a time, whoever is asking.
 *
 * Two surfaces can reach for the same chat at once — the banner's "Resume all" and a user clicking
 * one row — and both would otherwise take a hold, race the acquisition, and leave the loser's
 * refusal looking like a real failure. The second caller is told who holds it instead.
 */
export class StructuredAgentSessionResumeAdmission {
  private readonly owners = new Map<string, string>()

  liveOwner(sessionId: string): string | null {
    return this.owners.get(sessionId) ?? null
  }

  async run<T>(sessionId: string, owner: string, task: () => Promise<T>): Promise<T> {
    const live = this.owners.get(sessionId)
    if (live !== undefined) {
      throw new StructuredAgentSessionResumeInProgressError(live)
    }
    this.owners.set(sessionId, owner)
    try {
      return await task()
    } finally {
      this.owners.delete(sessionId)
    }
  }
}

export type StructuredAgentSessionResumeRunnerDeps = {
  admission: StructuredAgentSessionResumeAdmission
  /** Validates this action's durable reservation. False means the candidate is no longer eligible. */
  consumeMarker: (sessionId: string) => Promise<boolean>
  /** Acquires the provider child for the reserved session. */
  resume: (sessionId: string) => Promise<void>
  concurrency?: number
}

export async function resumeStructuredAgentSessionsFromRestart(
  deps: StructuredAgentSessionResumeRunnerDeps,
  candidates: readonly StructuredAgentSessionResumeCandidate[],
  owner: string
): Promise<StructuredAgentSessionResumeOutcome[]> {
  const outcomes: StructuredAgentSessionResumeOutcome[] = []
  await forEachWithConcurrency(
    candidates,
    deps.concurrency ?? STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
    async (candidate) => {
      outcomes.push(await resumeOne(deps, candidate.sessionId, owner))
    }
  )
  return outcomes
}

async function resumeOne(
  deps: StructuredAgentSessionResumeRunnerDeps,
  sessionId: string,
  owner: string
): Promise<StructuredAgentSessionResumeOutcome> {
  try {
    return await deps.admission.run(sessionId, owner, async () => {
      // Validate BEFORE provider acquisition. The durable reservation is removed only after the
      // action succeeds, and a failed acquisition reopens it for the next explicit attempt.
      if (!(await deps.consumeMarker(sessionId))) {
        return {
          sessionId,
          outcome: 'refused' as const,
          reason: 'agent_session_resume_not_eligible'
        }
      }
      await deps.resume(sessionId)
      return { sessionId, outcome: 'resumed' as const }
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const owner = resumeAdmissionOwner(error)
    return {
      sessionId,
      outcome: 'refused',
      reason,
      ...(owner === null ? {} : { owner })
    }
  }
}
