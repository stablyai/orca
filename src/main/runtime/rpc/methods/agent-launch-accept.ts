/** agent.launchAccept answers before its workspace's required Setup finishes; agent.launchStatus reads it.
 * Both reuse agent.launchReplay's admission, ledger and in-process execution: the host waits for Setup,
 * then starts one chat or terminal, or nothing. A caller never infers permission for another launch. */

import { abortSignalReason } from '../../../../shared/abort-signal-reason'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import {
  AgentLaunchAccept,
  AgentLaunchStatus,
  type AgentLaunchAcceptParams,
  type AgentLaunchAcceptResult,
  type AgentLaunchStatusResult
} from '../../../../shared/rpc-contract/agent-launch-accept-params'
import { agentLaunchFeatureRequirement } from '../agent-launch-feature-requirement'
import { defineMethod, type RpcContext } from '../core'
import { joinReplaySafeAgentLaunch } from './agent-launch'
import { activeAgentLaunchesFor } from './agent-launch-in-flight'
import { agentLaunchRefusalError } from './agent-launch-execution-outcome'
import {
  agentLaunchOperationCallerKey,
  recordedAgentLaunchAnswer,
  type AgentLaunchAdmission,
  type AgentLaunchRefusal
} from './agent-launch-replay'
import {
  assertAgentLaunchTargetAuthorized,
  supportsAgentLaunch
} from './agent-launch-target-authorization'
import { subscribeStructuredAgentSessionClose } from './structured-agent-session-close-before-create'

/** Refusals of the request itself, not outcomes of a launch: the caller must not read them as one. */
const REQUEST_REFUSALS: ReadonlySet<string> = new Set([
  'agent_session_operation_invalid',
  'agent_session_operation_conflict',
  'agent_session_operation_expired'
])

export const AGENT_LAUNCH_ACCEPT_METHODS = [
  defineMethod({
    name: 'agent.launchAccept',
    // An accepted launch never reuses a terminal: it always starts an agent.
    requires: () => agentLaunchFeatureRequirement({}),
    permission: 'workspace',
    params: AgentLaunchAccept,
    handler: (params, context): Promise<AgentLaunchAcceptResult> =>
      acceptAgentLaunch(params, context)
  }),
  defineMethod({
    name: 'agent.launchStatus',
    permission: 'workspace',
    params: AgentLaunchStatus,
    handler: (params, context): Promise<AgentLaunchStatusResult> =>
      readAgentLaunchStatus(params, context)
  })
]

async function acceptAgentLaunch(
  { terminalStartup, setupReceipt, prompt, ...params }: AgentLaunchAcceptParams,
  context: RpcContext
): Promise<AgentLaunchAcceptResult> {
  if (!supportsAgentLaunch(context)) {
    throw new Error('agent_launch_unsupported')
  }
  assertAgentLaunchTargetAuthorized(params.target, context)
  const { operationId } = params
  const launch = {
    ...params,
    ...(prompt ? { prompt: { text: prompt.text, delivery: prompt.delivery } } : {})
  }
  // Everything that decides what runs is identity, for a join here and for the durable row alike.
  const fingerprint = computeAgentLaunchFingerprint({
    ...launch,
    ...(prompt ? { prompt } : {}),
    ...(terminalStartup ? { terminalStartup } : {}),
    setupReceipt
  })
  const key = agentSessionOperationKey(agentLaunchOperationCallerKey(context), operationId)
  // Joined or started before any await: an overlapping accept shares this one's admission.
  let active = activeAgentLaunchesFor(context.runtime).get(key)
  if (active && active.fingerprint !== fingerprint) {
    throw new Error('agent_session_operation_conflict')
  }
  if (!active) {
    const closed = new AbortController()
    const unsubscribe = params.sessionId
      ? subscribeStructuredAgentSessionClose(params.sessionId, () => closed.abort())
      : () => {}
    active = joinReplaySafeAgentLaunch(launch, context, fingerprint, {
      setupReceipt,
      // Read only once admitted: a recorded answer never waits on this host's Setup registry.
      readSetupRun: async () =>
        context.runtime.getSetupRun(
          (await context.runtime.showTerminalWorkspaceLaunchScope(params.target.worktree)).id
        ),
      ...(terminalStartup ? { terminalStartup } : {}),
      ...(prompt ? { clientMessageId: prompt.clientMessageId } : {}),
      closed: closed.signal
    })
    // Detached: the ledger records how it ends, and a claimed row left unsettled reads as unknown.
    void active.promise.catch(() => {}).finally(unsubscribe)
  }
  const admission = await active.admitted
  if (!admission) {
    // Failed before admission decided anything: no row, so the caller hears the error itself.
    await active.promise
    throw new Error('agent_session_operation_unknown')
  }
  if (admission.decision === 'execute') {
    return { operationId, state: 'running' }
  }
  if (admission.decision === 'refuse' && REQUEST_REFUSALS.has(admission.refusal.code)) {
    throw agentLaunchRefusalError(admission.refusal)
  }
  return { operationId, ...statusOfAnswer(admission) }
}

async function readAgentLaunchStatus(
  { operationId, waitMs }: { operationId: string; waitMs?: number },
  context: RpcContext
): Promise<AgentLaunchStatusResult> {
  if (!supportsAgentLaunch(context)) {
    throw new Error('agent_launch_unsupported')
  }
  const callerKey = agentLaunchOperationCallerKey(context)
  const active = activeAgentLaunchesFor(context.runtime).get(
    agentSessionOperationKey(callerKey, operationId)
  )
  if (active && !(waitMs && (await settlesWithin(active.promise, waitMs, context.signal)))) {
    return { state: 'running' }
  }
  const store = await context.runtime.openAgentSessionRecordStore()
  const row = store.getOperationRow(callerKey, operationId)
  if (!row) {
    return { state: 'absent' }
  }
  // An unanswered row with nothing running here was claimed by a host that is gone: never run again.
  const answer = recordedAgentLaunchAnswer(context, operationId, row.outcome)
  return answer && answer.decision !== 'execute' ? statusOfAnswer(answer) : { state: 'unknown' }
}

function statusOfAnswer(
  answer: Exclude<AgentLaunchAdmission, { decision: 'execute' }>
): Exclude<AgentLaunchStatusResult, { state: 'running' | 'absent' }> {
  return answer.decision === 'replay'
    ? { state: 'succeeded', result: answer.result }
    : statusOfRefusal(answer.refusal)
}

function statusOfRefusal(
  refusal: AgentLaunchRefusal
): Extract<AgentLaunchStatusResult, { state: 'failed' | 'unknown' }> {
  if (refusal.code === 'agent_session_operation_unknown') {
    return { state: 'unknown' }
  }
  return { state: 'failed', code: refusal.code, ...(refusal.said ? { message: refusal.said } : {}) }
}

/** One shared observer per launch: a read that times out or is aborted leaves nothing behind. */
async function settlesWithin(
  promise: Promise<unknown>,
  waitMs: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  let abandoned: 'abort' | 'timeout' | undefined
  try {
    await sharedPromiseSettlementWaiters(promise).wait({
      timeoutMs: waitMs,
      ...(signal ? { signal, createAbortError: () => abortSignalReason(signal) } : {}),
      onAbandon: (reason) => {
        abandoned = reason
      }
    })
  } catch (error) {
    if (abandoned === 'abort') {
      throw error
    }
    return abandoned !== 'timeout'
  }
  return true
}
