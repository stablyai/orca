/**
 * The verdict vocabulary for resuming an idle assigned worker.
 *
 * Every reason a resume did not execute gets its own name. Collapsing them is what makes a
 * coordinator retry: "it did not work" reads as "send it again", while "the worker is mid-turn"
 * and "its process exited" call for opposite actions. Nothing here writes or decides authority —
 * it maps evidence to a name, so the same rules can be read without a runtime.
 *
 * Deliberately no synonyms for the liveness pair: `exited_process` is a death certificate and
 * `unknown_liveness` is lost contact, which is never evidence of death
 * (docs/reference/ssh-execution-boundary.md).
 */

import type { WorkerTurnStartVerdict } from '../rpc/methods/orchestration/worker/worker-start-turn-observation'
import type { StructuredDispatchState } from './structured-session-pointer-delivery'

export const WORKER_RESUME_STATES = [
  'resumed',
  'queued_prompt',
  'missing_acknowledgement',
  'active_turn',
  'denied_action',
  'exited_process',
  'unknown_liveness'
] as const

export type WorkerResumeState = (typeof WORKER_RESUME_STATES)[number]

/** A state a resume can report without ever reaching the delivery route. */
export type WorkerResumeRefusalState = Exclude<WorkerResumeState, 'resumed' | 'queued_prompt'>

export type WorkerResumeObservation =
  | 'unattached'
  | 'missing'
  | 'identity_changed'
  | 'live'
  | 'exited'
  | 'unverifiable'

export type WorkerResumePreconditionFacts = {
  observation: WorkerResumeObservation
  /** A turn is already running for this assignee. */
  turnRunning: boolean
  /** Orca looked and found the assignee parked on something only a human can clear. */
  awaitingHuman: boolean
  /** The assignee still holds a mailbox Delivery it never acknowledged. */
  unacknowledgedDelivery: boolean
}

export type WorkerResumePrecondition =
  | { deliver: true }
  | { deliver: false; state: WorkerResumeRefusalState }

/**
 * Whether the resume prompt may be delivered at all, and which state to report when it may not.
 *
 * Ordered by how conclusive the evidence is, so the answer never depends on which fact was read
 * first: a process that is gone outranks anything observed about its agent, lost contact outranks
 * a stale status, and an assignee that is already holding unconsumed guidance outranks the empty
 * case that actually wants a nudge.
 */
export function classifyWorkerResumePrecondition(
  facts: WorkerResumePreconditionFacts
): WorkerResumePrecondition {
  if (facts.observation === 'exited' || facts.observation === 'identity_changed') {
    return { deliver: false, state: 'exited_process' }
  }
  if (facts.observation !== 'live') {
    // `unattached`, `missing` and `unverifiable` all mean Orca cannot reach the assignee's
    // process to ask. None of them proves it is dead, so none of them may say so.
    return { deliver: false, state: 'unknown_liveness' }
  }
  if (facts.turnRunning) {
    return { deliver: false, state: 'active_turn' }
  }
  if (facts.awaitingHuman) {
    // A prompt sent here queues behind an approval only a human can clear, which reads to the
    // agent as part of the blocked turn rather than as a new instruction.
    return { deliver: false, state: 'denied_action' }
  }
  if (facts.unacknowledgedDelivery) {
    // The assignee was already handed a batch and has not acknowledged it. A second prompt would
    // duplicate guidance it is holding, so the acknowledgement is what is missing, not a nudge.
    return { deliver: false, state: 'missing_acknowledgement' }
  }
  return { deliver: true }
}

/** Why the supported route declined to carry the prompt. Never inferred from prose. */
export type WorkerResumeRefusal =
  /** The agent is behind a permission prompt; the route refuses to write past a guard. */
  | 'blocked_on_human'
  /** The target proved unwritable: no live PTY holds the recorded incarnation. */
  | 'not_writable'
  /** The attempt ended without proving whether anything landed. */
  | 'unprovable'

export type WorkerResumeDeliveryOutcome =
  | {
      route: 'terminal'
      /** False when the host accepted input but returned no durable prompt receipt. */
      receipted: boolean
      verdict: WorkerTurnStartVerdict
    }
  | { route: 'structured'; dispatchState: StructuredDispatchState }
  | { route: 'refused'; refusal: WorkerResumeRefusal }

/**
 * The state a delivered resume reports.
 *
 * `resumed` requires proof a turn started, or a provider that exposes no turn-start signal at all,
 * where an accepted write is the strongest receipt that can exist and is never a failure. Anything
 * weaker is named for what is missing: the prompt sits with the agent unexecuted (`queued_prompt`),
 * or nothing came back to say it arrived (`missing_acknowledgement`).
 */
export function classifyWorkerResumeDelivery(
  outcome: WorkerResumeDeliveryOutcome
): WorkerResumeState {
  if (outcome.route === 'refused') {
    return outcome.refusal === 'blocked_on_human'
      ? 'denied_action'
      : outcome.refusal === 'not_writable'
        ? 'exited_process'
        : 'unknown_liveness'
  }
  if (outcome.route === 'structured') {
    return outcome.dispatchState === 'accepted'
      ? 'resumed'
      : outcome.dispatchState === 'rejected'
        ? 'denied_action'
        : // The adapters cannot tell a dead provider child from a slow acknowledgement apart.
          'missing_acknowledgement'
  }
  if (!outcome.receipted) {
    return 'missing_acknowledgement'
  }
  switch (outcome.verdict) {
    case 'observed':
    case 'unsupported':
      return 'resumed'
    case 'permission':
      return 'denied_action'
    case 'unobserved':
      return 'queued_prompt'
  }
}

/**
 * What a resumed worker is told.
 *
 * It names the worker's own Dispatch mailbox rather than telling it to poll: the selector is the
 * whole point of the resume, because a reused pane's implicit check reads a bound Run instead.
 */
export function buildWorkerResumePrompt(input: {
  cliCommand: string
  workerHandle: string
  dispatchId: string
  note?: string
}): string {
  const read = `${input.cliCommand} orchestration check --terminal ${input.workerHandle} --dispatch ${input.dispatchId} --json`
  return [
    'Your coordinator resumed this dispatched task. Read your Dispatch mailbox now and act on',
    'what it holds before continuing; it may redirect or stop the work you were doing.',
    ...(input.note ? ['', input.note] : []),
    '',
    read
  ].join('\n')
}

/** One sentence per state, so every surface says the same thing about what to do next. */
export function describeWorkerResumeState(state: WorkerResumeState): string {
  switch (state) {
    case 'resumed':
      return 'The worker started a turn on the resume prompt.'
    case 'queued_prompt':
      return 'The resume prompt was accepted but no turn started from it; the agent is holding it. Do not send it again — look at the worker; a repeat is only safe as the same `--retry-request <same id>`, which replays this answer instead of prompting twice.'
    case 'missing_acknowledgement':
      return 'Nothing acknowledged the guidance the worker already holds. Wait for it to acknowledge its batch, or stop the Attempt; a second prompt would duplicate it, and only a repeat under the same `--retry-request <same id>` is free of that.'
    case 'active_turn':
      return 'The worker is mid-turn. A prompt sent now folds into the work already in flight.'
    case 'denied_action':
      return 'The worker is behind a decision only a human can make, or the route refused the write. Clear it in the pane; Orca will not write past a guard.'
    case 'exited_process':
      return 'The assigned worker process is gone. Retry the Task on a new Attempt rather than resuming this one.'
    case 'unknown_liveness':
      return 'Orca cannot reach the assigned worker to tell whether it is alive. This is unverifiable, never proof it is dead.'
  }
}
