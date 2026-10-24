// Manual/automatic Resume share admission and send a continuation, never replaying the original prompt.

import {
  isAgentSessionRefusalError,
  type AgentSessionAnyRefusalDetails
} from '../../../shared/agent-session-wire-refusals'
import { availableParallelism } from 'node:os'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import type { StructuredAgentSessionResumeCandidate } from './structured-agent-session-restart-resume-set'

/** Bound CPU-heavy startup per host core; ready chats run concurrently. */
export const STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY = Math.max(1, availableParallelism())

export const STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS =
  'agent_session_resume_already_in_progress'

export const STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE = 'agent_session_resume_not_eligible'

export type StructuredAgentSessionResumeOutcome = {
  sessionId: string
  outcome: 'resumed' | 'refused'
  /** Refusal code; in-progress refusals identify the live owner. */
  reason?: string
  /** Keep details separate from the stable refusal code. */
  details?: AgentSessionAnyRefusalDetails
  owner?: string
}

export class StructuredAgentSessionResumeInProgressError extends Error {
  constructor(readonly owner: string) {
    super(STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS)
    this.name = 'StructuredAgentSessionResumeInProgressError'
  }
}

function resumeAdmissionOwner(error: unknown): string | null {
  return error instanceof StructuredAgentSessionResumeInProgressError ? error.owner : null
}

/** Share host startup slots and exclusive per-session ownership across all callers. */
export class StructuredAgentSessionResumeAdmission {
  private readonly owners = new Map<string, string>()
  private readonly starts: PrioritySemaphore

  constructor(startLimit: number = STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY) {
    this.starts = new PrioritySemaphore(startLimit)
  }

  liveOwner(sessionId: string): string | null {
    return this.owners.get(sessionId) ?? null
  }

  async run<T>(
    sessionId: string,
    owner: string,
    task: () => Promise<T>,
    onPhase?: (phase: 'queued' | 'starting') => void
  ): Promise<T> {
    const live = this.owners.get(sessionId)
    if (live !== undefined) {
      throw new StructuredAgentSessionResumeInProgressError(live)
    }
    // Claim before waiting for capacity so competing callers see the queued owner.
    this.owners.set(sessionId, owner)
    try {
      onPhase?.('queued')
      const release = await this.starts.acquire(0)
      try {
        onPhase?.('starting')
        return await task()
      } finally {
        release()
      }
    } finally {
      this.owners.delete(sessionId)
    }
  }
}

export type StructuredAgentSessionResumeRunnerDeps = {
  admission: StructuredAgentSessionResumeAdmission
  onPhase?: (sessionId: string, phase: 'queued' | 'starting') => void
  onRefused?: (sessionId: string) => void
  consumeMarker: (sessionId: string) => Promise<boolean>
  /** Resolve at handover/start failure, before the provider’s final answer. */
  resume: (sessionId: string) => Promise<void>
}

export async function resumeStructuredAgentSessionsFromRestart(
  deps: StructuredAgentSessionResumeRunnerDeps,
  candidates: readonly StructuredAgentSessionResumeCandidate[],
  owner: string
): Promise<StructuredAgentSessionResumeOutcome[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const outcome = await resumeOne(deps, candidate.sessionId, owner)
      if (outcome.outcome === 'refused') {
        deps.onRefused?.(candidate.sessionId)
      }
      return outcome
    })
  )
}

async function resumeOne(
  deps: StructuredAgentSessionResumeRunnerDeps,
  sessionId: string,
  owner: string
): Promise<StructuredAgentSessionResumeOutcome> {
  try {
    return await deps.admission.run(
      sessionId,
      owner,
      async () => {
        // Validate reservation before acquisition; failed attempts may reopen only after action settlement.
        if (!(await deps.consumeMarker(sessionId))) {
          return {
            sessionId,
            outcome: 'refused' as const,
            reason: STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE
          }
        }
        await deps.resume(sessionId)
        return { sessionId, outcome: 'resumed' as const }
      },
      (phase) => deps.onPhase?.(sessionId, phase)
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const owner = resumeAdmissionOwner(error)
    const details = isAgentSessionRefusalError(error) ? error.refusal.details : undefined
    return {
      sessionId,
      outcome: 'refused',
      reason,
      ...(details ? { details } : {}),
      ...(owner === null ? {} : { owner })
    }
  }
}
