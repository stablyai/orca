import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { MaestroTerminalLaunchProfile } from '../../../../../shared/maestro-terminal-lease'
import type { OrchestrationDb } from '../../db'
import { OrchestrationError } from '../../orchestration-error'

export function buildWorkerTerminalLaunchProfile(
  effective?: {
    agent?: MaestroTerminalLaunchProfile['agent']
    model?: string | null
    effort?: string | null
    permissionMode?: string | null
    serviceTier?: MaestroTerminalLaunchProfile['serviceTier']
    environmentPolicy?: string | null
  } | null
): MaestroTerminalLaunchProfile {
  return {
    agent: effective?.agent ?? null,
    model: effective?.model ?? null,
    effort: effective?.effort ?? null,
    permissionMode: effective?.permissionMode ?? 'default',
    routeRef: null,
    serviceTier: effective?.serviceTier ?? null,
    environmentPolicy: effective?.environmentPolicy ?? null
  }
}

export function getRetryWorkerTerminalPreflight(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  retryOf: string
  attemptId: string
  terminalHandle: string
  runId: string
  taskId: string
  coordinatorGeneration: number
}) {
  const paneKey = args.runtime.getTerminalPaneKey(args.terminalHandle)
  const processIncarnation = args.runtime.getTerminalProcessIncarnation(args.terminalHandle)
  const resource = args.db.getWorkerTerminalResourceByOwner(args.retryOf)
  const predecessorLease = resource
    ? args.db.getMaestroTerminalLeaseByWorkerResource(resource.id)
    : undefined
  const managedCliContext = args.runtime.buildTerminalManagedCliContext(args.terminalHandle)
  if (
    !paneKey ||
    !processIncarnation ||
    !resource ||
    resource.ownership_state !== 'owned' ||
    resource.release_state !== 'not_requested' ||
    resource.terminal_handle !== args.terminalHandle ||
    resource.pane_key !== paneKey ||
    resource.process_incarnation !== processIncarnation ||
    !predecessorLease ||
    predecessorLease.ownerPrincipal !== `dispatch:${args.retryOf}` ||
    predecessorLease.runId !== args.runId ||
    predecessorLease.taskId !== args.taskId ||
    predecessorLease.attemptId !== args.attemptId ||
    predecessorLease.terminalHandle !== args.terminalHandle ||
    predecessorLease.ptyIncarnation !== processIncarnation ||
    predecessorLease.executionHostId !== managedCliContext.executionHostId ||
    predecessorLease.workspaceKey !== managedCliContext.workspaceKey ||
    predecessorLease.coordinatorGeneration !== args.coordinatorGeneration
  ) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      `Retry ${args.retryOf} does not have one transferable Maestro terminal lease.`
    )
  }
  return {
    resourceId: resource.id,
    predecessorLeaseId: predecessorLease.id,
    terminalHandle: args.terminalHandle,
    paneKey,
    processIncarnation,
    executionHostId: managedCliContext.executionHostId,
    workspaceKey: managedCliContext.workspaceKey
  }
}

export function prepareWorkerTerminalTransferAuthority(args: {
  db: OrchestrationDb
  terminalHandle: string
  terminalAuthority: {
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    hostScope?: string
  }
  retryOf?: string
  retryPreflight?: ReturnType<typeof getRetryWorkerTerminalPreflight>
  dispatchId: string
  worktreeId: string
  setupState: Parameters<OrchestrationDb['prepareStartingWorkerAuthority']>[0]['setupState']
  externalTerminal: boolean
  effects: Parameters<OrchestrationDb['prepareStartingWorkerAuthority']>[0]['effects']
}) {
  const retryResource = args.retryPreflight
    ? args.db.getWorkerTerminalResource(args.retryPreflight.resourceId)
    : undefined
  const predecessorLease = retryResource
    ? args.db.getMaestroTerminalLeaseByWorkerResource(retryResource.id)
    : undefined
  let reusableResourceId: string | undefined
  if (args.retryOf) {
    const preflight = args.retryPreflight
    if (
      !preflight ||
      !retryResource ||
      retryResource.ownership_state !== 'owned' ||
      retryResource.release_state !== 'not_requested' ||
      retryResource.terminal_handle !== preflight.terminalHandle ||
      retryResource.pane_key !== preflight.paneKey ||
      retryResource.process_incarnation !== preflight.processIncarnation ||
      !predecessorLease ||
      predecessorLease.id !== preflight.predecessorLeaseId ||
      predecessorLease.ownerPrincipal !== `dispatch:${args.retryOf}` ||
      args.terminalHandle !== preflight.terminalHandle ||
      args.terminalAuthority.paneKey !== preflight.paneKey ||
      args.terminalAuthority.processIncarnation !== preflight.processIncarnation
    ) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        `Retry ${args.retryOf} does not have one transferable Maestro terminal lease.`
      )
    }
  } else {
    const resource = args.db.findTransferableWorkerTerminalResource({
      terminalHandle: args.terminalHandle,
      paneKey: args.terminalAuthority.paneKey,
      processIncarnation: args.terminalAuthority.processIncarnation,
      hostScope: args.terminalAuthority.hostScope ?? null
    })
    if (resource && args.db.getMaestroTerminalLeaseByWorkerResource(resource.id)) {
      reusableResourceId = resource.id
    }
  }
  const capability = args.db.prepareStartingWorkerAuthority({
    dispatchId: args.dispatchId,
    handle: args.terminalHandle,
    ...args.terminalAuthority,
    worktreeId: args.worktreeId,
    effects: args.effects,
    setupState: args.setupState,
    terminalOwnership: args.externalTerminal ? 'external' : 'created',
    deferExternalTerminalTransfer: Boolean(args.retryOf || reusableResourceId)
  })
  return { predecessorLeaseId: predecessorLease?.id, reusableResourceId, capability }
}
