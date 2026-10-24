import {
  hostFoundingAdmission,
  type HostFoundingAttempt
} from '../../../agent-launch/host-founding-attempt'
import {
  AGENT_LAUNCH_CANCELLED_CODE,
  AgentLaunchCancelledError,
  type AgentLaunchCancelResult
} from '../../../../shared/agent-launch-cancellation'
import {
  agentSessionOperationKey,
  agentSessionOperationExpiry
} from '../../../../shared/agent-session-operation-ledger'
import { parseAgentSessionOperationTimestamp } from '../../../../shared/agent-session-host-authority'
import { isAgentLaunchResult } from '../../../../shared/agent-launch-intent'

import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'

import type { RpcContext } from '../core'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'

import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'

import type { ActiveAgentLaunch } from './agent-launch'
export async function cancelAgentLaunch(
  params: AgentLaunchParams & { operationId: string },
  context: RpcContext,
  active: Map<string, ActiveAgentLaunch>
): Promise<AgentLaunchCancelResult> {
  const callerKey = agentLaunchOperationCallerKey(context)
  const key = agentSessionOperationKey(callerKey, params.operationId)
  const fingerprint = computeAgentLaunchFingerprint(params)
  let owner = active.get(key)
  if (owner && owner.fingerprint !== fingerprint) {
    throw new Error('agent_session_operation_conflict')
  }
  if (owner) {
    const proof = hostFoundingAdmission(owner.hostFoundingAttempt)
    if (proof.surfaceAdmitted) {
      return { status: 'admitted', ...proof }
    }
    if (owner.cancelPromise) {
      return owner.cancelPromise
    }
  }
  const existingOwner = owner !== undefined
  if (!owner) {
    const attempt: HostFoundingAttempt = {
      cancellation: { controller: new AbortController(), requested: true, retain: true }
    }
    const promise = Promise.resolve().then(async (): Promise<AgentLaunchResult> => {
      const result = await owner?.cancelPromise
      if (result?.result) {
        return result.result
      }
      throw result?.status === 'cancelled'
        ? new AgentLaunchCancelledError()
        : new Error('agent_session_operation_unknown')
    })
    void promise.catch(() => {})
    owner = { fingerprint, hostFoundingAttempt: attempt, promise }
    active.set(key, owner)
    const timestamp = parseAgentSessionOperationTimestamp(params.operationId)
    setTimeout(
      () => {
        if (active.get(key) === owner) {
          active.delete(key)
        }
      },
      agentSessionOperationExpiry(timestamp ?? Date.now(), Date.now()) - Date.now()
    ).unref()
  }
  const attempt = owner.hostFoundingAttempt
  const proof = hostFoundingAdmission(attempt)
  if (proof.surfaceAdmitted) {
    return { status: 'admitted', ...proof }
  }
  const unresolved =
    attempt.opening?.transaction.disposition === 'unresolved' ||
    attempt.blank?.disposition === 'unresolved'
  const livePrevention = Boolean(
    attempt.cancellation &&
    !attempt.terminalDispatched &&
    !unresolved &&
    attempt.disposition !== 'replay'
  )
  if (livePrevention && attempt.cancellation) {
    attempt.cancellation.requested = true
    attempt.cancellation.retain = true
    attempt.cancellation.controller.abort()
  }
  const held = owner
  owner.cancelPromise = (async (): Promise<AgentLaunchCancelResult> => {
    let recordedFailure: Error | undefined
    try {
      const store = await context.runtime.openAgentSessionRecordStore()
      const outcome = await store.cancelLaunchOperation({
        callerKey,
        operationId: params.operationId,
        fingerprint,
        now: Date.now(),
        livePrevention: existingOwner && livePrevention,
        code: AGENT_LAUNCH_CANCELLED_CODE
      })
      if (outcome.status === 'failed') {
        if (attempt.cancellation) {
          attempt.cancellation.retain = false
        }
        if (outcome.code !== AGENT_LAUNCH_CANCELLED_CODE) {
          recordedFailure = Object.assign(new Error(outcome.message ?? outcome.code), {
            code: outcome.code
          })
          throw recordedFailure
        }
        return { status: 'cancelled' }
      }
      if (outcome.status === 'succeeded' && isAgentLaunchResult(outcome.launch)) {
        if (attempt.cancellation) {
          attempt.cancellation.retain = false
        }
        return {
          status: 'admitted',
          surfaceAdmitted: true,
          result: outcome.launch
        }
      }
      return { status: 'unknown', ...hostFoundingAdmission(attempt) }
    } catch (error) {
      if (
        error === recordedFailure ||
        (error instanceof Error &&
          /^agent_session_operation_(invalid|expired|conflict)$/.test(error.message))
      ) {
        if (attempt.cancellation) {
          attempt.cancellation.retain = false
        }
        throw error
      }
      console.warn('[agent-launch] cancellation persistence failed', error)
      return { status: 'unknown', ...hostFoundingAdmission(attempt) }
    } finally {
      if (!existingOwner && !attempt.cancellation?.retain && active.get(key) === held) {
        active.delete(key)
      }
    }
  })()
  return owner.cancelPromise
}
