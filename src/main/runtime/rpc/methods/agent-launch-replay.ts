/** Admit before live selector/lease checks so replay returns the recorded answer despite changed preconditions.
 * At-most-once admission refuses unknown outcomes; recovering stranded surfaces is a separate responsibility. */

import { deriveAgentLaunchChildOperationId } from '../../../../shared/agent-launch-operation'
import {
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../../shared/agent-launch-tab-closed'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type {
  AgentSessionOperationOutcome,
  AgentSessionOperationRefusalCode
} from '../../../../shared/agent-session-operation-ledger'
import { resolveAgentSessionReplayOutcome } from '../../../native-chat/agent-session-wire/structured-agent-session-replay-outcome'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { agentLaunchFailureMessage } from './agent-launch-failure-code'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'

/** Partition the ledger by transport-proven caller; an unnamed caller gets no replay safety or shared namespace. */
export function agentLaunchOperationCallerKey(context: Pick<RpcContext, 'caller'>): string {
  if (!context.caller) {
    throw new Error('agent_session_identity_required')
  }
  return rpcCallerOperationKey(context.caller)
}

/** Launch failures retain their own codes and original words (said), outside the closed agentSession refusal vocabulary. */
export type AgentLaunchRefusal = { code: string; message: string; said?: string }

export type AgentLaunchAdmission =
  /** This caller owns the operation. It alone runs the effect, and it must settle the row. */
  | {
      decision: 'execute'
      /** Record the surface immediately so restart can replay the running agent before final prompt settlement. */
      record: (provisional: AgentLaunchResult) => Promise<void>
      settle: (result: AgentLaunchResult) => Promise<void>
      /** `cause` is the refusal, whose own words a coded one keeps for its replay. */
      fail: (code: string, cause?: unknown) => Promise<void>
      /** Distinct from the launch id: the inner attach reserves in this same ledger. */
      attachOperationId: string
      callerKey: string
    }
  /** Already run under this id; hand back what it produced rather than producing it again. */
  | { decision: 'replay'; result: AgentLaunchResult }
  | { decision: 'refuse'; refusal: AgentLaunchRefusal }

/** An unclaimed pending row has no answer yet; rerun only means try to claim it. */
function answerFromRecordedRow(
  operationId: string,
  outcome: AgentSessionOperationOutcome
): AgentLaunchAdmission | null {
  if (outcome.status === 'failed') {
    // Replay the original code verbatim; narrowing to agentSession refusals would falsely label a failed launch as an invalid id and invite retry.
    return {
      decision: 'refuse',
      refusal: {
        code: outcome.code,
        message:
          outcome.message ?? `Launch operation ${operationId} already failed: ${outcome.code}.`,
        ...(outcome.message ? { said: outcome.message } : {})
      }
    }
  }
  const replay = resolveAgentSessionReplayOutcome<AgentLaunchResult>({
    operationId,
    outcome,
    // Validate payload here: an unreadable launch costs one replay, not the whole store.
    reconstruct: () =>
      outcome.status === 'succeeded' && isAgentLaunchResult(outcome.launch) ? outcome.launch : null
  })
  if (replay.decision === 'rerun') {
    return null
  }
  return replay.decision === 'replay'
    ? { decision: 'replay', result: replay.value }
    : { decision: 'refuse', refusal: replay.refusal }
}

/** A launch whose tab the user closed answers with its own word only to a caller that reads it. */
export function readsAgentLaunchTabClosed(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY) === true
  )
}

/** The CLI (no declared client) ships with this host; any other caller must say it reads the word. */
function readsUnconfirmedLaunchPrompt(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY) ===
      true
  )
}

/** Resolve the current handle by durable pane key when PTY incarnation or host re-adoption changed it.
 * Keep the recorded handle for an unknown pane: shipped clients require one, and an exited terminal is truthful. */
function withLiveTerminalHandle(
  recorded: AgentLaunchResult,
  runtime: Pick<RpcContext['runtime'], 'getTerminalHandleForPaneKey'>
): AgentLaunchResult {
  const { outcome } = recorded
  if (outcome.kind !== 'terminal' || !outcome.paneKey) {
    return recorded
  }
  const handle = runtime.getTerminalHandleForPaneKey(outcome.paneKey)
  return handle && handle !== outcome.handle
    ? { ...recorded, outcome: { ...outcome, handle } }
    : recorded
}

/** Expose unconfirmed only to capable callers; older callers retain refusal, never not-delivered that invites a duplicate turn. */
function presentRecordedAnswer(
  context: RpcContext,
  operationId: string,
  answer: AgentLaunchAdmission
): AgentLaunchAdmission {
  if (
    answer.decision === 'refuse' &&
    answer.refusal.code === AGENT_LAUNCH_TAB_CLOSED_CODE &&
    !readsAgentLaunchTabClosed(context)
  ) {
    return refusal(
      operationId,
      'agent_session_operation_unknown',
      'was stopped; its tab was closed'
    )
  }
  if (answer.decision !== 'replay') {
    return answer
  }
  if (answer.result.prompt?.outcome === 'unconfirmed' && !readsUnconfirmedLaunchPrompt(context)) {
    return refusal(
      operationId,
      'agent_session_operation_unknown',
      'started its agent, but whether its prompt arrived is unknown'
    )
  }
  return { decision: 'replay', result: withLiveTerminalHandle(answer.result, context.runtime) }
}

/** Admit and conditionally claim in one durable transaction.
 * Admission checks identity/consistency; only the claim selects one executor among concurrent retries. */
export async function admitAgentLaunchOperation(
  context: RpcContext,
  params: AgentLaunchParams & { operationId: string },
  fingerprint: string,
  now: number = Date.now()
): Promise<AgentLaunchAdmission> {
  const operationId = params.operationId
  const attachOperationId = deriveAgentLaunchChildOperationId(operationId)
  if (!attachOperationId) {
    return refusal(operationId, 'agent_session_operation_invalid', 'is not a durable operation id')
  }
  const callerKey = agentLaunchOperationCallerKey(context)
  // The ledger alone: admitting a terminal launch has no use for the chat host.
  const store = await context.runtime.openAgentSessionRecordStore()
  const { decision: admitted, claim } = await store.admitAndClaimOperation(
    { callerKey, operationId, fingerprint, now },
    // A fresh row, or a replayed one no one has answered yet, leaves the right to run open.
    (decision) =>
      decision.decision === 'admit' ||
      (decision.decision === 'replay' &&
        answerFromRecordedRow(operationId, decision.row.outcome) === null)
  )
  if (admitted.decision === 'refused') {
    return refusal(operationId, admitted.code, `was refused: ${admitted.code}`)
  }
  if (admitted.decision === 'replay') {
    const answer = answerFromRecordedRow(operationId, admitted.row.outcome)
    if (answer) {
      return presentRecordedAnswer(context, operationId, answer)
    }
  }
  // Unreachable with both steps in one transaction; answered as uncertain rather than run twice.
  if (!claim || claim.claim === 'absent') {
    return refusal(
      operationId,
      'agent_session_operation_unknown',
      'has no claim; its outcome is unknown'
    )
  }
  if (claim.claim === 'lost') {
    // Same-process retries already join; a claimed row here means restart uncertainty, never permission to run again.
    const answer = answerFromRecordedRow(operationId, claim.row.outcome)
    return answer
      ? presentRecordedAnswer(context, operationId, answer)
      : refusal(operationId, 'agent_session_operation_unknown', 'is claimed but unsettled')
  }
  const succeeded = (result: AgentLaunchResult) =>
    store.recordOperationOutcome({
      callerKey,
      operationId,
      outcome: {
        status: 'succeeded',
        // A terminal surface has a handle, not a session id; `launch` carries whichever it is.
        sessionId: result.outcome.kind === 'structured' ? result.outcome.sessionId : '',
        launch: result
      }
    })
  return {
    decision: 'execute',
    attachOperationId,
    callerKey,
    // The same row shape twice: a build that predates the first write reads either one.
    record: succeeded,
    settle: succeeded,
    fail: (code, cause) => {
      const message = agentLaunchFailureMessage(cause)
      return store.recordOperationOutcome({
        callerKey,
        operationId,
        outcome: { status: 'failed', code, ...(message ? { message } : {}) }
      })
    }
  }
}

function refusal(
  operationId: string,
  code: AgentSessionOperationRefusalCode | 'agent_session_operation_unknown',
  detail: string
): AgentLaunchAdmission {
  return {
    decision: 'refuse',
    refusal: { code, message: `Launch operation ${operationId} ${detail}.` }
  }
}
