import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  consumeWorkerAuthorityPolicyCapability,
  createWorkerAuthorityIsolationAttestation,
  type WorkerAuthorityIsolationLaunchRequest,
  type WorkerAuthorityPolicyCapability
} from '../../../../shared/worker-authority-policy'
import { WORKER_AUTHORITY_IMAGE } from '../../../providers/worker-authority-isolation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  createWorkerContainerLifecycleBoundary,
  monitorWorkerContainerLifecycle,
  type WorkerContainerLifecycleBoundary
} from '../../orchestration/worker-container-lifecycle'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

export function consumeWorkerAuthorityCapability(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  agent: TuiAgent | undefined
  createsWorktree: boolean
  resolvedWorktreeId: string | undefined
}): WorkerAuthorityPolicyCapability | undefined {
  if (!args.params.policy) {
    return undefined
  }
  if (
    args.params.policy !== NO_GITHUB_AUTHORITY_POLICY ||
    !args.params.capabilityRef ||
    !args.agent ||
    args.params.terminal ||
    args.createsWorktree ||
    !args.resolvedWorktreeId ||
    args.params.setup !== 'skip'
  ) {
    throw new OrchestrationError(
      'worker_authority_capability_stale',
      'The worker authority capability does not match this launch vector.'
    )
  }
  const capability = consumeWorkerAuthorityPolicyCapability({
    capabilityRef: args.params.capabilityRef,
    policy: args.params.policy,
    runtimeId: args.runtime.getRuntimeId(),
    agentId: args.agent,
    worktreeId: args.resolvedWorktreeId,
    setupPolicy: args.params.setup
  })
  if (!capability) {
    throw new OrchestrationError(
      'worker_authority_capability_stale',
      'The worker authority capability is expired, consumed, or target-mismatched.'
    )
  }
  if (!args.runtime.supportsWorkerAuthorityIsolation(args.agent)) {
    throw new OrchestrationError(
      'worker_authority_policy_unsupported',
      'The selected process owner no longer supports NO_GITHUB_AUTHORITY.'
    )
  }
  return capability
}

export function createWorkerAuthorityLaunch(args: {
  capability: WorkerAuthorityPolicyCapability | undefined
  dispatchId: string
  worktreeId: string | undefined
}): {
  isolation?: WorkerAuthorityIsolationLaunchRequest
  lifecycle?: WorkerContainerLifecycleBoundary
} {
  if (!args.capability || !args.worktreeId) {
    return {}
  }
  const lifecycle = createWorkerContainerLifecycleBoundary({
    dispatchId: args.dispatchId,
    capabilityRef: args.capability.capabilityRef
  })
  return {
    lifecycle,
    isolation: {
      schemaVersion: 'worker_authority_launch/1',
      policy: args.capability.policy,
      policyDigest: args.capability.policyDigest,
      capabilityRef: args.capability.capabilityRef,
      dispatchId: args.dispatchId,
      worktreeId: args.worktreeId,
      setupPolicy: args.capability.setupPolicy,
      imageDigest: WORKER_AUTHORITY_IMAGE,
      lifecycleDirectory: lifecycle.directory,
      lifecycleBinding: lifecycle.binding
    }
  }
}

export async function persistWorkerAuthorityAttestation(args: {
  isolation: WorkerAuthorityIsolationLaunchRequest | undefined
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  terminalHandle: string
  agent: TuiAgent
  processIncarnation: string
}) {
  if (!args.isolation) {
    return undefined
  }
  const attestation = createWorkerAuthorityIsolationAttestation({
    request: args.isolation,
    runtimeId: args.runtime.getRuntimeId(),
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    agentId: args.agent,
    processIncarnation: args.processIncarnation
  })
  try {
    args.db.recordWorkerAuthorityAttestation(args.dispatchId, attestation)
  } catch (error) {
    await args.runtime.closeTerminal(args.terminalHandle).catch(() => undefined)
    throw error
  }
  return attestation
}

export function monitorWorkerAuthorityLifecycle(args: {
  lifecycle: WorkerContainerLifecycleBoundary | undefined
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
  taskId: string
  dispatchId: string
  terminalHandle: string
}): void {
  if (!args.lifecycle) {
    return
  }
  monitorWorkerContainerLifecycle({
    db: args.db,
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    terminalHandle: args.terminalHandle,
    lifecycle: args.lifecycle,
    notify: (handle, messageType) => args.runtime.notifyMessageArrived(handle, messageType)
  })
}
