import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkerAuthorityPolicyCapability } from '../../../../shared/worker-authority-policy'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import type { WorkerEffect, WorkerSetupReceipt } from './orchestration-worker-topology'

export function resolveWorkerStartTimeoutMs(timeoutMs: number | undefined): number {
  if (!isWorkerStartTimeoutWithinTimerLimit(timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  return resolveWorkerStartReadinessTimeoutMs(timeoutMs)
}

export function buildWorkerStartOptions(args: {
  params: WorkerStartInput
  requestedWorktree: string
  resolvedWorktreeId: string | undefined
  creationRepoId: string | undefined
  createsWorktree: boolean
  agent: TuiAgent | undefined
  launchReceipt: unknown
  authorityCapability: WorkerAuthorityPolicyCapability | undefined
  readinessTimeoutMs: number
}) {
  return {
    worktree: args.requestedWorktree,
    resolvedWorktreeId: args.resolvedWorktreeId ?? null,
    name: args.params.name ?? null,
    repo: args.params.repo ?? args.creationRepoId ?? null,
    baseBranch: args.params.baseBranch ?? null,
    terminal: args.params.terminal ?? null,
    agent: args.agent ?? null,
    launch: args.launchReceipt,
    timeoutMs: args.readinessTimeoutMs,
    setup: args.createsWorktree
      ? (args.params.setup ?? 'run')
      : (args.params.setup ?? 'not_applicable'),
    setupSource: args.createsWorktree
      ? args.params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : args.params.policy
        ? 'authority_preflight'
        : 'existing_worktree',
    ...(args.authorityCapability
      ? {
          authorityPolicy: {
            policy: args.authorityCapability.policy,
            policyDigest: args.authorityCapability.policyDigest,
            capabilityRef: args.authorityCapability.capabilityRef
          }
        }
      : {})
  }
}

export function buildInitialWorkerPlacementReceipt(args: {
  resolvedWorktreeId: string | undefined
  authorityPolicyRequested: boolean
}): { effects: WorkerEffect[]; setupReceipt: WorkerSetupReceipt } {
  const isolated = args.authorityPolicyRequested
  const effects: WorkerEffect[] = args.resolvedWorktreeId
    ? [
        { kind: 'worktree', action: 'reused', id: args.resolvedWorktreeId },
        isolated
          ? { kind: 'setup', action: 'skip', state: 'skipped' }
          : { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
      ]
    : []
  return {
    effects,
    setupReceipt: {
      requested: isolated ? 'skip' : 'not_applicable',
      effective: isolated ? 'skip' : 'not_applicable',
      source: isolated ? 'authority_preflight' : 'existing_worktree',
      hookFound: false,
      startupPolicy: 'start-immediately',
      state: isolated ? 'skipped' : 'not_applicable'
    }
  }
}

export async function sendWorkerDispatchInput(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  taskId: string
  dispatchId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  depth: number
  devMode: boolean | undefined
  isolated: boolean
  effects: WorkerEffect[]
}): Promise<void> {
  const preamble = buildDispatchPreamble({
    canDispatchSubWorkers: !args.isolated && args.depth < args.runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: args.terminalHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(args.terminalHandle),
    ...(args.isolated ? { lifecycleAdapter: 'container-file' as const } : {})
  })
  await args.runtime.sendTerminalAgentPrompt(args.terminalHandle, preamble)
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
}
