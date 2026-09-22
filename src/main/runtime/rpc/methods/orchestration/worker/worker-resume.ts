import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { generateId } from '../../../../orchestration/db/generated-id'
import { WorkerResumeParams } from '../../../../../../shared/rpc-contract/orchestration-worker-resume-params'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { readStructuredSessionGateFacts } from '../../../../orchestration/structured-mailbox-pointer-host'
import {
  observeStructuredWorker,
  resolveStructuredWorkerForDispatch
} from '../../orchestration-structured-worker-lifecycle'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import { inspectWorkerTerminal } from './worker-observation'
import { observeWorkerTurnStart } from './worker-start-turn-observation'
import {
  buildWorkerResumePrompt,
  classifyWorkerResumeDelivery,
  classifyWorkerResumePrecondition,
  describeWorkerResumeState,
  type WorkerResumeDeliveryOutcome,
  type WorkerResumeState
} from '../../../../orchestration/worker-resume-state'

/**
 * Resume an idle assigned worker, once.
 *
 * Exactly-once is not this handler's own invention: `orchestration.workerResume` is a durable
 * orchestration mutation, so a caller that passes `--retry-request` gets the recorded receipt
 * replayed instead of a second prompt, and an ambiguous transport is a replay rather than a
 * resend. That only holds while every delivery outcome RETURNS — a throw discards the pending
 * receipt and makes the next retry write again — which is why nothing below the guard throws.
 *
 * Nothing here creates a Task, a Dispatch or an Attempt. Resume acts on the assignment that
 * already exists, or it refuses.
 *
 * The prompt travels the same supported routes a dispatch preamble does: the gated agent-prompt
 * write, or a structured session turn. No raw text-plus-Enter anywhere — the agent-session write
 * gate is what refuses to type past a permission prompt, and going around it is what this route
 * exists to avoid.
 */
export const ORCHESTRATION_WORKER_RESUME_METHODS = [
  defineMethod({
    name: 'orchestration.workerResume',
    params: WorkerResumeParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = requireResumableDispatch(db, params.dispatch)
      const unacknowledgedDelivery = db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)
      const structured = resolveStructuredWorkerForDispatch(db, dispatch.id)
      return structured
        ? await resumeStructuredWorker({
            structured,
            dispatchId: dispatch.id,
            unacknowledgedDelivery,
            note: params.note
          })
        : await resumeTerminalWorker({
            runtime,
            db,
            dispatchId: dispatch.id,
            unacknowledgedDelivery,
            note: params.note
          })
    }
  })
]

function requireResumableDispatch(db: OrchestrationDb, dispatchId: string) {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
  }
  if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${dispatchId} is ${dispatch.status}. Resume acts on a live assignment; retry the Task instead of resuming a settled Attempt.`
    )
  }
  if (db.getFederatedDispatch(dispatchId)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Dispatch ${dispatchId} executes on a connected worker server. Resume it from the host that owns its execution.`
    )
  }
  return dispatch
}

function receipt(input: {
  dispatchId: string
  state: WorkerResumeState
  route: 'terminal' | 'structured'
  observation: string
  prompt?: unknown
}) {
  return {
    dispatchId: input.dispatchId,
    state: input.state,
    resumed: input.state === 'resumed',
    route: input.route,
    observation: input.observation,
    detail: describeWorkerResumeState(input.state),
    ...(input.prompt ? { prompt: input.prompt } : {})
  }
}

async function resumeTerminalWorker(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  unacknowledgedDelivery: boolean
  note: string | undefined
}) {
  const { runtime, db, dispatchId } = args
  const observed = await inspectWorkerTerminal(runtime, db, dispatchId)
  const handle = observed.terminalHandle
  // Why guarded on `live`: the status getter answers from the pane's own snapshot, which a
  // replaced or unreachable process can still answer for.
  const agentStatus =
    handle && observed.status === 'live'
      ? await runtime.getTerminalAgentStatus(handle).catch(() => null)
      : null
  const precondition = classifyWorkerResumePrecondition({
    observation: handle ? observed.status : 'unattached',
    turnRunning: agentStatus?.status === 'working',
    awaitingHuman: agentStatus?.status === 'permission' || observed.agentWait != null,
    unacknowledgedDelivery: args.unacknowledgedDelivery
  })
  if (!precondition.deliver || !handle) {
    return receipt({
      dispatchId,
      state: precondition.deliver ? 'unknown_liveness' : precondition.state,
      route: 'terminal',
      observation: observed.status
    })
  }
  const prompt = buildWorkerResumePrompt({
    cliCommand: runtime.getTerminalOrchestrationCliCommand(handle),
    workerHandle: handle,
    dispatchId,
    ...(args.note ? { note: args.note } : {})
  })
  let outcome: WorkerResumeDeliveryOutcome
  let delivery: unknown
  try {
    const send = await runtime.sendTerminalAgentPrompt(handle, prompt, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: generateId('resume')
    })
    const turn = await observeWorkerTurnStart({
      runtime,
      terminalHandle: handle,
      prompt: send.prompt
    })
    delivery = turn.prompt
    outcome = { route: 'terminal', receipted: send.prompt !== undefined, verdict: turn.verdict }
  } catch (error) {
    outcome = { route: 'refused', refusal: terminalResumeRefusal(error) }
  }
  return receipt({
    dispatchId,
    state: classifyWorkerResumeDelivery(outcome),
    route: 'terminal',
    observation: observed.status,
    ...(delivery ? { prompt: delivery } : {})
  })
}

/**
 * The runtime's own refusal vocabulary, read as codes rather than prose.
 *
 * `agent_prompt_blocked` is the guard doing its job: a permission prompt is showing and the write
 * is withheld. Anything unrecognised is unprovable, never a death certificate.
 */
function terminalResumeRefusal(error: unknown): 'blocked_on_human' | 'not_writable' | 'unprovable' {
  const message = error instanceof Error ? error.message : ''
  if (message === 'agent_prompt_blocked') {
    return 'blocked_on_human'
  }
  return message === 'terminal_not_writable' ? 'not_writable' : 'unprovable'
}

async function resumeStructuredWorker(args: {
  structured: StructuredWorkerIdentity
  dispatchId: string
  unacknowledgedDelivery: boolean
  note: string | undefined
}) {
  const { structured, dispatchId } = args
  const observed = observeStructuredWorker(structured)
  const gate = readStructuredSessionGateFacts(structured.sessionId)
  const precondition = classifyWorkerResumePrecondition({
    // An unreadable journal is an unattached session, which is lost contact, not a dead child.
    observation: gate ? observed.status : 'unverifiable',
    turnRunning: gate?.turnRunning === true,
    awaitingHuman: gate?.awaitingHuman === true,
    unacknowledgedDelivery: args.unacknowledgedDelivery
  })
  const host = getStructuredAgentSessionHost()
  if (!precondition.deliver || !host) {
    return receipt({
      dispatchId,
      state: precondition.deliver ? 'unknown_liveness' : precondition.state,
      route: 'structured',
      observation: observed.status
    })
  }
  let outcome: WorkerResumeDeliveryOutcome
  try {
    await sendStructuredWorkerPreamble({
      host,
      sessionId: structured.sessionId,
      dispatchId,
      preamble: buildWorkerResumePrompt({
        cliCommand: 'orca',
        workerHandle: structured.handle,
        dispatchId,
        ...(args.note ? { note: args.note } : {})
      })
    })
    outcome = { route: 'structured', dispatchState: 'accepted' }
  } catch (error) {
    outcome = structuredResumeOutcome(error)
  }
  return receipt({
    dispatchId,
    state: classifyWorkerResumeDelivery(outcome),
    route: 'structured',
    observation: observed.status
  })
}

/** The session sender reports its verdict as a code; only those two are verdicts about delivery. */
function structuredResumeOutcome(error: unknown): WorkerResumeDeliveryOutcome {
  const code = error instanceof OrchestrationError ? error.code : ''
  if (code === 'dispatch_preamble_undelivered') {
    return { route: 'structured', dispatchState: 'rejected' }
  }
  return code === 'operation_unknown'
    ? { route: 'structured', dispatchState: 'unknown' }
    : { route: 'refused', refusal: 'unprovable' }
}
