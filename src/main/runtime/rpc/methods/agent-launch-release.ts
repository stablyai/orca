/** agent.launchPrepare claims a launch exactly as agent.launchAccept does, but its execution waits after
 * Setup for agent.launchRelease to hand it the first turn's final choices. The host stays the only
 * owner of every effect: release installs one immutable input into the caller's own live launch, and a
 * durable child record acknowledges that input without ever creating a chat or terminal itself. */

import {
  computeAgentLaunchFingerprint,
  deriveAgentLaunchChildOperationId
} from '../../../../shared/agent-launch/contracts/agent-launch-operation'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import type {
  AgentLaunchAcceptResult,
  AgentLaunchStatusResult
} from '../../../../shared/rpc-contract/agent-launch-accept-params'
import {
  AgentLaunchPrepare,
  AgentLaunchRelease,
  type AgentLaunchPrepareParams,
  type AgentLaunchReleaseParams,
  type AgentLaunchReleaseResult
} from '../../../../shared/rpc-contract/agent-launch-release-params'
import {
  AgentLaunchReleaseGate,
  agentLaunchReleaseDigest
} from '../../../agent-launch/agent-launch-release-gate'
import { agentLaunchFeatureRequirement } from '../agent-launch-feature-requirement'
import { defineMethod, type RpcContext } from '../core'
import { answerAcceptedAgentLaunch, readRecordedAgentLaunchStatus } from './agent-launch-accept'
import { agentLaunchRefusalError, settleQuietly } from './agent-launch-execution-outcome'
import { agentLaunchFailureCode } from './agent-launch-failure-code'
import { activeAgentLaunchesFor, type ActiveAgentLaunch } from './agent-launch-in-flight'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'
import {
  assertAgentLaunchTargetAuthorized,
  supportsAgentLaunch
} from './agent-launch-target-authorization'

export const AGENT_LAUNCH_RELEASE_METHODS = [
  defineMethod({
    name: 'agent.launchPrepare',
    // A prepared launch, like an accepted one, never reuses a terminal: it always starts an agent.
    requires: () => agentLaunchFeatureRequirement({}),
    permission: 'workspace',
    params: AgentLaunchPrepare,
    handler: (params, context): Promise<AgentLaunchAcceptResult> =>
      prepareAgentLaunch(params, context)
  }),
  defineMethod({
    name: 'agent.launchRelease',
    requires: () => agentLaunchFeatureRequirement({}),
    permission: 'workspace',
    params: AgentLaunchRelease,
    handler: (params, context): Promise<AgentLaunchReleaseResult> =>
      releaseAgentLaunch(params, context)
  })
]

function prepareAgentLaunch(
  { terminalAlternative, setupReceipt, prompt, ...params }: AgentLaunchPrepareParams,
  context: RpcContext
): Promise<AgentLaunchAcceptResult> {
  const launch = {
    ...params,
    ...(prompt ? { prompt: { text: prompt.text, delivery: prompt.delivery } } : {})
  }
  // Its own namespace: a prepared launch never joins or replays an accepted one under the same id.
  const fingerprint = computeAgentLaunchFingerprint(
    { ...launch, ...(prompt ? { prompt } : {}), terminalAlternative, setupReceipt },
    'agent.launchPrepare'
  )
  return answerAcceptedAgentLaunch(launch, context, fingerprint, {
    setupReceipt,
    ...(prompt ? { clientMessageId: prompt.clientMessageId } : {}),
    release: (closed) =>
      new AgentLaunchReleaseGate(
        terminalAlternative,
        params.agent,
        prompt?.text ?? '',
        closed,
        params.target
      )
  })
}

async function releaseAgentLaunch(
  { operationId, ...input }: AgentLaunchReleaseParams,
  context: RpcContext
): Promise<AgentLaunchReleaseResult> {
  if (!supportsAgentLaunch(context)) {
    throw new Error('agent_launch_unsupported')
  }
  const callerKey = agentLaunchOperationCallerKey(context)
  const digest = agentLaunchReleaseDigest(input)
  const active = activeAgentLaunchesFor(context.runtime).get(
    agentSessionOperationKey(callerKey, operationId)
  )
  if (!active) {
    // Nothing of this caller's runs under the id: a reply lost after the launch ended reads its outcome.
    return { operationId, ...(await endedLaunchAnswer(context, callerKey, operationId, digest)) }
  }
  const gate = active.release
  if (!gate) {
    // An accepted launch already holds its choices; no input may change what it runs.
    throw new Error('agent_session_operation_conflict')
  }
  assertAgentLaunchTargetAuthorized(gate.target, context)
  // Joined or started before any await: an identical release shares one admission, any other conflicts.
  if (gate.admission && gate.admission.digest !== digest) {
    throw new Error('agent_session_operation_conflict')
  }
  gate.admission ??= {
    digest,
    answer: admitRelease(context, active, gate, { callerKey, operationId, digest, input })
  }
  return { operationId, ...(await gate.admission.answer) }
}

async function admitRelease(
  context: RpcContext,
  active: ActiveAgentLaunch,
  gate: AgentLaunchReleaseGate,
  release: {
    callerKey: string
    operationId: string
    digest: string
    input: Omit<AgentLaunchReleaseParams, 'operationId'>
  }
): Promise<AgentLaunchStatusResult> {
  const { callerKey, operationId, digest } = release
  const admission = await active.admitted
  const childId = deriveAgentLaunchChildOperationId(operationId, 'release')
  // The clock is read here too: a host waking past the horizon refuses before recording anything.
  if (!admission || admission.decision !== 'execute' || !childId || gate.waitEnded()) {
    return launchOutcome(context, active, callerKey, operationId)
  }
  const store = await context.runtime.openAgentSessionRecordStore()
  const { decision, claim } = await store.admitAndClaimOperation(
    { callerKey, operationId: childId, fingerprint: digest, now: Date.now() },
    (admitted) => admitted.decision === 'admit'
  )
  if (decision.decision === 'refused') {
    throw agentLaunchRefusalError({
      code: decision.code,
      message: `Launch operation ${operationId} release was refused: ${decision.code}.`
    })
  }
  // Only the caller's current live launch takes the input, after a fresh clock check in install.
  const live =
    activeAgentLaunchesFor(context.runtime).get(
      agentSessionOperationKey(callerKey, operationId)
    ) === active
  const installed = live && gate.install(digest, release.input)
  if (claim?.claim === 'won') {
    // The child only acknowledges the input: like a terminal launch's row, it names no session.
    const ended = gate.endedWithoutInput
    await settleQuietly(
      store.recordOperationOutcome({
        callerKey,
        operationId: childId,
        outcome: installed
          ? { status: 'succeeded', sessionId: '' }
          : { status: 'failed', code: agentLaunchFailureCode(ended) }
      })
    )
  }
  return installed ? { state: 'running' } : launchOutcome(context, active, callerKey, operationId)
}

/** The parent's own answer once it ends; a wait that ended without input ends it at once. */
async function launchOutcome(
  context: RpcContext,
  active: ActiveAgentLaunch,
  callerKey: string,
  operationId: string
): Promise<AgentLaunchStatusResult> {
  await active.promise.catch(() => {})
  return readRecordedAgentLaunchStatus(context, callerKey, operationId)
}

/** A release for a launch not running here: the same input reads the launch's outcome, another one
 *  conflicts, and an unknown or absent launch stays so. Nothing is installed or run. */
async function endedLaunchAnswer(
  context: RpcContext,
  callerKey: string,
  operationId: string,
  digest: string
): Promise<AgentLaunchStatusResult> {
  const childId = deriveAgentLaunchChildOperationId(operationId, 'release')
  const store = await context.runtime.openAgentSessionRecordStore()
  const child = childId ? store.getOperationRow(callerKey, childId) : null
  if (child && child.fingerprint !== digest) {
    throw new Error('agent_session_operation_conflict')
  }
  return readRecordedAgentLaunchStatus(context, callerKey, operationId)
}
