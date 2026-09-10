import type {
  MaestroTerminalCleanupReceipt,
  MaestroTerminalLease
} from '../../../../../shared/maestro-terminal-lease'
import { normalizeExecutionHostId } from '../../../../../shared/execution-host'
import { parsePtyStopReceipt, type PtyStopReceipt } from '../../../../../shared/pty-stop-receipt'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'

type ReconciliationArgs = {
  runtime: OrcaRuntimeService
  leaseId: string
  currentCoordinatorGeneration: number | null
  runFinalState?: {
    allRequiredTasksGraded: boolean
    questionsSettled: boolean
    cleanupVerifiedOrRetained: boolean
  }
}

export async function reconcileMaestroTerminalLease(args: ReconciliationArgs) {
  const db = args.runtime.getOrchestrationDb()
  const lease = db.getMaestroTerminalLease(args.leaseId)
  if (!lease) {
    throw new OrchestrationError('lease_not_found', `Terminal lease ${args.leaseId} was not found.`)
  }
  if (lease.role === 'worker') {
    return {
      leaseId: lease.id,
      action: 'delegated_to_worker_release',
      cleanupReceipt: lease.cleanupReceipt
    }
  }
  if (lease.lifecycleState === 'released' || lease.lifecycleState === 'archived') {
    return { leaseId: lease.id, action: 'released', cleanupReceipt: lease.cleanupReceipt }
  }
  if (isExternallyAdoptedCoordinator(lease)) {
    db.retainMaestroTerminalLease(lease.id)
    return { leaseId: lease.id, action: 'retained', cleanupReceipt: null }
  }
  const fenced =
    lease.coordinatorGeneration !== null &&
    args.currentCoordinatorGeneration !== null &&
    lease.coordinatorGeneration < args.currentCoordinatorGeneration
  const finalStateVerified =
    args.runFinalState?.allRequiredTasksGraded === true &&
    args.runFinalState.questionsSettled === true &&
    args.runFinalState.cleanupVerifiedOrRetained === true
  if (!fenced && !finalStateVerified) {
    db.retainMaestroTerminalLease(lease.id)
    return { leaseId: lease.id, action: 'retained', cleanupReceipt: null }
  }
  if (!lease.terminalHandle || !lease.paneKey || !lease.ptyIncarnation) {
    db.retainMaestroTerminalLease(lease.id)
    return { leaseId: lease.id, action: 'retained', cleanupReceipt: null }
  }
  if (!provesManagedIdentity(args.runtime, lease)) {
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'outcome_unknown' })
    return { leaseId: lease.id, action: 'outcome_unknown', cleanupReceipt: null }
  }
  const archivedTail = await readArchivedTail(args.runtime, lease.terminalHandle)
  if (lease.lifecycleState !== 'retained' && lease.lifecycleState !== 'settled') {
    db.retainMaestroTerminalLease(lease.id)
  }
  db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'release_pending' })
  const close = await args.runtime.closeTerminal(lease.terminalHandle)
  const providerStopReceipt = parseExactStopReceipt(close.ptyStopReceipt, lease)
  const observedAt = providerStopReceipt?.timestamp ?? new Date().toISOString()
  if (!close.ptyKilled || !providerStopReceipt) {
    return recordUnknownOutcome({
      runtime: args.runtime,
      lease,
      archivedTail,
      providerStopReceipt: close.ptyStopReceipt,
      observedAt
    })
  }
  const replacement = await findReplacement(args.runtime, lease)
  if (replacement) {
    return recordUnknownOutcome({
      runtime: args.runtime,
      lease,
      archivedTail,
      providerStopReceipt,
      observedAt,
      replacement
    })
  }
  const cleanupReceipt: MaestroTerminalCleanupReceipt = {
    verdict: 'exited',
    processTreeVerified: true,
    closedTerminalHandle: lease.terminalHandle,
    replacementTerminalHandle: null,
    replacementIncarnation: null,
    archiveRef: null,
    observedAt,
    providerStopReceipt
  }
  db.transitionMaestroTerminalLease({
    leaseId: lease.id,
    state: 'released',
    cleanupReceipt,
    archivedTail
  })
  return { leaseId: lease.id, action: 'released', cleanupReceipt }
}

function isExternallyAdoptedCoordinator(lease: MaestroTerminalLease): boolean {
  return (
    lease.launchProfile.routeRef === 'adopted-external-coordinator' ||
    lease.launchProfile.routeRef === 'adopted-current-coordinator'
  )
}

function provesManagedIdentity(runtime: OrcaRuntimeService, lease: MaestroTerminalLease): boolean {
  return runtime.proveManagedTerminalIdentity({
    terminalHandle: lease.terminalHandle!,
    executionHostId: lease.executionHostId,
    workspaceKey: lease.workspaceKey,
    paneKey: lease.paneKey!,
    ptyIncarnation: lease.ptyIncarnation!
  })
}

async function readArchivedTail(runtime: OrcaRuntimeService, terminalHandle: string) {
  try {
    const read = await runtime.readTerminal(terminalHandle, { limit: 80 })
    return read.tail.join('\n').slice(-8_192)
  } catch {
    return null
  }
}

function parseExactStopReceipt(
  receipt: PtyStopReceipt | undefined,
  lease: MaestroTerminalLease
): PtyStopReceipt | null {
  if (!receipt || !lease.terminalHandle || !lease.ptyIncarnation) {
    return null
  }
  const executionHostId = normalizeExecutionHostId(lease.executionHostId)
  if (!executionHostId) {
    return null
  }
  try {
    const parsed = parsePtyStopReceipt(receipt, {
      executionHostId,
      terminalHandle: lease.terminalHandle,
      ...(lease.processRootId ? { ptyId: lease.processRootId } : {}),
      ptyIncarnation: lease.ptyIncarnation
    })
    return parsed.verdict === 'exited' && parsed.processTreeVerified ? parsed : null
  } catch {
    return null
  }
}

async function findReplacement(runtime: OrcaRuntimeService, lease: MaestroTerminalLease) {
  if (!lease.tabId || !lease.terminalHandle) {
    return null
  }
  try {
    const inventory = await runtime.listTerminals()
    const candidate = inventory.terminals.find(
      (terminal) => terminal.tabId === lease.tabId && terminal.handle !== lease.terminalHandle
    )
    return candidate
      ? {
          handle: candidate.handle,
          incarnation: runtime.getTerminalProcessIncarnation(candidate.handle)
        }
      : null
  } catch {
    return null
  }
}

function recordUnknownOutcome(args: {
  runtime: OrcaRuntimeService
  lease: MaestroTerminalLease
  archivedTail: string | null
  providerStopReceipt?: PtyStopReceipt
  observedAt: string
  replacement?: { handle: string; incarnation: string | null }
}) {
  const cleanupReceipt: MaestroTerminalCleanupReceipt = {
    verdict: 'unverifiable',
    processTreeVerified: false,
    closedTerminalHandle: args.lease.terminalHandle,
    replacementTerminalHandle: args.replacement?.handle ?? null,
    replacementIncarnation: args.replacement?.incarnation ?? null,
    archiveRef: null,
    observedAt: args.observedAt,
    ...(args.providerStopReceipt ? { providerStopReceipt: args.providerStopReceipt } : {})
  }
  args.runtime.getOrchestrationDb().transitionMaestroTerminalLease({
    leaseId: args.lease.id,
    state: 'outcome_unknown',
    cleanupReceipt,
    archivedTail: args.archivedTail
  })
  return { leaseId: args.lease.id, action: 'outcome_unknown', cleanupReceipt }
}
