import { createHash } from 'node:crypto'
import type {
  MaestroTerminalLaunchProfile,
  MaestroTerminalLease
} from '../../../../../../shared/maestro-terminal-lease'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import type { WorkerEffect } from './worker-topology'
import type { DurableWorkerMutationIdentity } from '../../orchestration-worker-terminal-lease-types'
import type { prepareWorkerTerminalTransferAuthority } from '../../../../orchestration/db/worker-terminal/worker-terminal-start-authority'

export type WorkerTerminalLeaseArgs = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
  taskId: string
  taskSpec: string
  canDispatchSubWorkers: boolean
  coordinatorGeneration: number
  dispatchId: string
  attemptId: string
  retryOf?: string
  mutation?: DurableWorkerMutationIdentity
  retryPreflight?: Parameters<typeof prepareWorkerTerminalTransferAuthority>[0]['retryPreflight']
  terminalHandle: string
  terminal: { tabId?: string; ptyId?: string | null }
  terminalAuthority: { paneKey: string; processIncarnation: string; hostScope?: string }
  preflightExecutable: string
  retryResourceId?: string
  retryPredecessorLeaseId?: string
  reusableResourceId?: string
  leaseTitle: string
  launchProfile: MaestroTerminalLaunchProfile
  capability: string
  coordinatorHandle: string
  devMode?: boolean
  effects: WorkerEffect[]
  onLeaseTransfer: (
    receipt: ReturnType<OrchestrationDb['transferMaestroWorkerTerminalLease']>
  ) => void
}

export type PreparedWorkerTerminalLease = {
  managedCliContext: ReturnType<OrcaRuntimeService['buildTerminalManagedCliContext']>
  tabId: string
  workerLease: MaestroTerminalLease
  transferReceipt?: ReturnType<OrchestrationDb['transferMaestroWorkerTerminalLease']>
}

export function prepareWorkerTerminalLease(
  args: WorkerTerminalLeaseArgs
): PreparedWorkerTerminalLease {
  const { db, runtime } = args
  runtime.assertTerminalManagedCliAvailable(args.terminalHandle)
  const managedCliContext = runtime.buildTerminalManagedCliContext(args.terminalHandle)
  if (managedCliContext.executable !== args.preflightExecutable) {
    throw new Error(
      `managed_cli_profile_drift: preflighted executable "${args.preflightExecutable}" does not match the resolved "${managedCliContext.executable}" for terminal ${args.terminalHandle}.`
    )
  }
  const hostScope = args.terminalAuthority.hostScope ?? null
  const tabId =
    args.terminal.tabId ??
    args.terminalAuthority.paneKey.slice(0, args.terminalAuthority.paneKey.indexOf(':'))
  const resource =
    db.getWorkerTerminalResourceByOwner(args.dispatchId) ??
    db.findTransferableWorkerTerminalResource({
      terminalHandle: args.terminalHandle,
      paneKey: args.terminalAuthority.paneKey,
      processIncarnation: args.terminalAuthority.processIncarnation,
      hostScope
    })
  const predecessorLease = resource
    ? db.getMaestroTerminalLeaseByWorkerResource(resource.id)
    : undefined
  if (args.retryOf && resource?.id !== args.retryResourceId) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      `Retry ${args.retryOf} terminal ownership changed before transfer.`
    )
  }
  if (args.retryOf && predecessorLease?.id !== args.retryPredecessorLeaseId) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      `Retry ${args.retryOf} terminal lease changed before transfer.`
    )
  }
  const leaseParams = {
    requestId: `worker:${args.runId}:${args.dispatchId}`,
    executionHostId: managedCliContext.executionHostId,
    workspaceKey: managedCliContext.workspaceKey,
    runId: args.runId,
    taskId: args.taskId,
    attemptId: args.attemptId,
    coordinatorGeneration: args.coordinatorGeneration,
    role: 'worker' as const,
    title: args.leaseTitle,
    launchProfile: args.launchProfile,
    spawnedBy: `coordinator:g${args.coordinatorGeneration}`,
    ownerPrincipal: `dispatch:${args.dispatchId}`,
    retentionPolicy: 'auto_release' as const
  }
  let transferReceipt: ReturnType<OrchestrationDb['transferMaestroWorkerTerminalLease']> | undefined
  let workerLease
  if (predecessorLease && (args.retryOf || resource?.id === args.reusableResourceId)) {
    transferReceipt = db.transferMaestroWorkerTerminalLease({
      requestId: `worker-transfer:${args.runId}:${args.dispatchId}`,
      mutation: args.mutation,
      kind: args.retryOf ? 'strict_retry' : 'settled_resource_reuse',
      predecessorLeaseId: predecessorLease.id,
      successorRequestId: leaseParams.requestId,
      successorDispatchId: args.dispatchId,
      runId: args.runId,
      taskId: args.taskId,
      attemptId: args.attemptId,
      terminalHandle: args.terminalHandle,
      paneKey: args.terminalAuthority.paneKey,
      ptyIncarnation: args.terminalAuthority.processIncarnation,
      processRootId: args.terminal.ptyId ?? null,
      executionHostId: managedCliContext.executionHostId,
      workspaceKey: managedCliContext.workspaceKey,
      hostScope,
      predecessorOwnerPrincipal: predecessorLease.ownerPrincipal,
      successorOwnerPrincipal: `dispatch:${args.dispatchId}`,
      coordinatorGeneration: args.coordinatorGeneration,
      title: args.leaseTitle,
      launchProfile: args.launchProfile,
      retentionPolicy: predecessorLease.retentionPolicy,
      spawnedBy: leaseParams.spawnedBy
    })
    args.onLeaseTransfer(transferReceipt)
    workerLease = db.getMaestroTerminalLease(transferReceipt.successorLeaseId)
  } else {
    workerLease = db.reserveMaestroTerminalLease(leaseParams)
    db.attachMaestroTerminalLease({
      leaseId: workerLease.id,
      terminalHandle: args.terminalHandle,
      tabId,
      paneKey: args.terminalAuthority.paneKey,
      ptyIncarnation: args.terminalAuthority.processIncarnation,
      processRootId: args.terminal.ptyId ?? null,
      executionHostId: managedCliContext.executionHostId,
      workspaceKey: managedCliContext.workspaceKey,
      workerTerminalResourceId: resource?.id ?? null
    })
    db.transitionMaestroTerminalLease({ leaseId: workerLease.id, state: 'ready' })
  }
  if (!workerLease) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker terminal lease transfer did not create one successor owner.'
    )
  }
  return { managedCliContext, tabId, workerLease, transferReceipt }
}

export async function activateWorkerTerminalLease(
  args: WorkerTerminalLeaseArgs & { prepared?: PreparedWorkerTerminalLease }
) {
  const { db, runtime } = args
  const { managedCliContext, tabId, workerLease, transferReceipt } =
    args.prepared ?? prepareWorkerTerminalLease(args)
  const preamble = buildDispatchPreamble({
    canDispatchSubWorkers: args.canDispatchSubWorkers,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: args.terminalHandle,
    dispatchCapability: args.capability,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(args.terminalHandle),
    managedCliContext,
    requiresManagedCliContext: true
  })
  const commandId = `dispatch:${args.dispatchId}:preamble`
  const inputAcceptance = db.acceptMaestroTerminalInput({
    commandId,
    idempotencyKey: commandId,
    contentDigest: `sha256:${createHash('sha256').update(preamble).digest('hex')}`,
    enqueueSequence: 1,
    sender: {
      principalId: `coordinator:${args.coordinatorHandle}`,
      authority: 'coordinator',
      runId: args.runId,
      coordinatorGeneration: args.coordinatorGeneration
    },
    leaseId: workerLease.id,
    executionHostId: managedCliContext.executionHostId,
    workspaceKey: managedCliContext.workspaceKey,
    terminalHandle: args.terminalHandle,
    tabId,
    ptyIncarnation: args.terminalAuthority.processIncarnation,
    expectedLifecycleState: workerLease.lifecycleState === 'active' ? 'active' : 'ready',
    observedInputSurface: 'ready_prompt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expectedGraphRevision: null
  })
  if (inputAcceptance.replayed && inputAcceptance.receipt.state === 'accepted') {
    db.transitionMaestroTerminalInput({
      commandId: inputAcceptance.receipt.commandId,
      state: 'delivery_unknown',
      rejectionCode: 'delivery_interrupted_before_receipt'
    })
    throw new Error('worker_preamble_delivery_unknown')
  }
  let prompt: Awaited<ReturnType<OrcaRuntimeService['sendTerminalAgentPrompt']>> | undefined
  if (!inputAcceptance.replayed) {
    const send = await runtime.sendTerminalAgentPrompt(args.terminalHandle, preamble, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: args.mutation?.requestId ?? args.dispatchId
    })
    prompt = send
    db.transitionMaestroTerminalInput({
      commandId: inputAcceptance.receipt.commandId,
      state: send.accepted ? 'written_to_pty' : 'delivery_unknown',
      bytesWritten: send.bytesWritten,
      enterWritten: send.accepted
    })
    if (!send.accepted) {
      throw new Error('dispatch_input_delivery_unknown')
    }
  } else if (!['written_to_pty', 'acknowledged'].includes(inputAcceptance.receipt.state)) {
    throw new Error(`worker_preamble_${inputAcceptance.receipt.state}`)
  }
  db.transitionMaestroTerminalLease({ leaseId: workerLease.id, state: 'active' })
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
  return { workerLease, transferReceipt, prompt }
}
