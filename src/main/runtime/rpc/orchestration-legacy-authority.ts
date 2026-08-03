import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type {
  DispatchContextRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole
} from '../orchestration/types'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { LEGACY_CONTRACT_VERSION } from '../orchestration/db'
import type { RpcRequest } from './core'
import {
  equivalentLegacyPaneKey,
  legacyCoordinatorReadOnly,
  legacyReadOnlyError
} from './orchestration-legacy-process-identity'

export type LegacyPrincipalCandidate = {
  runId: string
  role: LegacyPrincipalRole
  dispatchId?: string
  terminalHandle: string
  paneKey: string
}

export function resolveAttestedLegacyPrincipal(args: {
  runtime: OrcaRuntimeService
  evidence?: OrchestrationCompatibilityEvidence
  candidate: LegacyPrincipalCandidate
  authority?: OrchestrationCompatibilityCallerAuthority
}): LegacyCompatibilityPrincipalRow {
  const authority = args.authority ?? verifyAttestedLegacyCandidate(args)
  return args.runtime.getOrchestrationDb().commitLegacyCompatibilityPrincipal({
    runId: args.candidate.runId,
    dispatchId: args.candidate.dispatchId,
    role: args.candidate.role,
    hostScope: JSON.stringify(authority.hostScope),
    terminalHandle: args.candidate.terminalHandle,
    paneKey: args.candidate.paneKey,
    launchTokenHash: authority.launchTokenHash,
    processIncarnation: authority.processIncarnation
  }).principal
}

export function verifyAttestedLegacyCandidate(args: {
  runtime: OrcaRuntimeService
  evidence?: OrchestrationCompatibilityEvidence
  candidate: LegacyPrincipalCandidate
}) {
  const authority = args.runtime.verifyOrchestrationCompatibilityCaller(args.evidence)
  if (
    !authority ||
    !equivalentLegacyPaneKey(args.candidate.paneKey, authority.paneKey) ||
    args.candidate.terminalHandle !== authority.terminalHandle
  ) {
    throw legacyReadOnlyError()
  }
  if (
    args.candidate.role === 'worker' &&
    args.candidate.dispatchId &&
    !args.runtime.getOrchestrationDb().isDispatchProcessCurrent({
      dispatchId: args.candidate.dispatchId,
      paneKey: authority.paneKey,
      processIncarnation: authority.processIncarnation
    })
  ) {
    throw legacyReadOnlyError()
  }
  return authority
}

export class LegacyCompatibilityAuthority {
  constructor(private readonly runtime: OrcaRuntimeService) {}

  resolveWorkerDispatch(
    request: RpcRequest,
    target: { terminalHandle?: string; dispatchId?: string; taskId?: string }
  ): DispatchContextRow | undefined {
    const db = this.runtime.getOrchestrationDb()
    const evidence = request.orchestrationCompatibilityEvidence
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id
    const existing = adoptedRunId
      ? db.resolveLegacyCompatibilityPrincipalByIdentity({
          runId: adoptedRunId,
          role: 'worker',
          terminalHandle: evidence?.terminalHandle,
          paneKey: evidence?.paneKey
        })
      : undefined
    if (existing?.dispatch_id) {
      verifyAttestedLegacyCandidate({
        runtime: this.runtime,
        evidence,
        candidate: candidateFromPrincipal(existing)
      })
      const settledDispatch = db.getDispatchContextById(existing.dispatch_id)
      if (
        settledDispatch &&
        (!target.dispatchId || target.dispatchId === settledDispatch.id) &&
        (!target.taskId || target.taskId === settledDispatch.task_id)
      ) {
        return settledDispatch
      }
    }
    const dispatch = db.resolveLegacyWorkerCandidate({
      runId: adoptedRunId,
      terminalHandle: evidence?.terminalHandle ?? target.terminalHandle,
      paneKey: evidence?.paneKey,
      dispatchId: target.dispatchId,
      taskId: target.taskId
    })?.dispatch
    if (!dispatch && evidence) {
      const retained = db.resolveLegacyWorkerCandidate({
        runId: adoptedRunId,
        terminalHandle: target.terminalHandle,
        dispatchId: target.dispatchId,
        taskId: target.taskId
      })
      if (retained) {
        throw legacyReadOnlyError()
      }
    }
    return dispatch
  }

  resolveAskDispatch(
    request: RpcRequest,
    params: { from?: string; resume?: string }
  ): DispatchContextRow | undefined {
    const db = this.runtime.getOrchestrationDb()
    if (params.resume) {
      const question = db.getQuestion(params.resume)
      return question ? db.getDispatchContextById(question.dispatch_id) : undefined
    }
    return this.resolveWorkerDispatch(request, { terminalHandle: params.from })
  }

  resolveCheckPrincipal(
    request: RpcRequest,
    terminalHandle?: string
  ): LegacyCompatibilityPrincipalRow | undefined {
    const db = this.runtime.getOrchestrationDb()
    const adoption = db.getLegacyAdoption()
    if (!adoption) {
      return undefined
    }
    const evidence = request.orchestrationCompatibilityEvidence
    const existingWorker = db.resolveLegacyCompatibilityPrincipalByIdentity({
      runId: adoption.adopted_run_id,
      role: 'worker',
      terminalHandle: evidence?.terminalHandle,
      paneKey: evidence?.paneKey
    })
    if (existingWorker) {
      verifyAttestedLegacyCandidate({
        runtime: this.runtime,
        evidence,
        candidate: candidateFromPrincipal(existingWorker)
      })
      return existingWorker
    }
    const worker = db.resolveLegacyWorkerCandidate({
      runId: adoption.adopted_run_id,
      terminalHandle: evidence?.terminalHandle ?? terminalHandle,
      paneKey: evidence?.paneKey
    })
    if (worker) {
      return this.attestWorker(request, worker.dispatch)
    }
    if (evidence) {
      const retained = db.resolveLegacyWorkerCandidate({
        runId: adoption.adopted_run_id,
        terminalHandle
      })
      const settled = db.resolveLegacyCompatibilityPrincipalByIdentity({
        runId: adoption.adopted_run_id,
        role: 'worker',
        terminalHandle
      })
      if (retained || settled) {
        throw legacyReadOnlyError()
      }
    }
    return this.attestCoordinator(request, adoption.adopted_run_id, false)
  }

  attestWorker(request: RpcRequest, dispatch: DispatchContextRow): LegacyCompatibilityPrincipalRow {
    if (dispatch.contract_version !== LEGACY_CONTRACT_VERSION) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${dispatch.id} does not use the legacy contract.`
      )
    }
    return resolveAttestedLegacyPrincipal({
      runtime: this.runtime,
      evidence: request.orchestrationCompatibilityEvidence,
      candidate: candidateFromDispatch(dispatch)
    })
  }

  attestCoordinator(
    request: RpcRequest,
    runId: string,
    required = true
  ): LegacyCompatibilityPrincipalRow | undefined {
    const db = this.runtime.getOrchestrationDb()
    const candidate = db.resolveLegacyCoordinatorCandidate({
      runId,
      terminalHandle: request.orchestrationCompatibilityEvidence?.terminalHandle,
      paneKey: request.orchestrationCompatibilityEvidence?.paneKey
    })
    if (!candidate) {
      if (required) {
        throw legacyCoordinatorReadOnly()
      }
      return undefined
    }
    const principal = resolveAttestedLegacyPrincipal({
      runtime: this.runtime,
      evidence: request.orchestrationCompatibilityEvidence,
      candidate: {
        runId,
        role: 'coordinator',
        terminalHandle: candidate.terminalHandle,
        paneKey: candidate.paneKey
      }
    })
    return principal
  }
}

function candidateFromDispatch(dispatch: DispatchContextRow): LegacyPrincipalCandidate {
  if (!dispatch.assignee_handle || !dispatch.assignee_pane_key) {
    throw new OrchestrationError(
      'legacy_read_only',
      `Dispatch ${dispatch.id} lacks durable process identity. No effects were applied.`
    )
  }
  return {
    runId: dispatch.run_id,
    role: 'worker',
    dispatchId: dispatch.id,
    terminalHandle: dispatch.assignee_handle,
    paneKey: dispatch.assignee_pane_key
  }
}

function candidateFromPrincipal(
  principal: LegacyCompatibilityPrincipalRow
): LegacyPrincipalCandidate {
  return {
    runId: principal.run_id,
    role: principal.role,
    dispatchId: principal.dispatch_id ?? undefined,
    terminalHandle: principal.terminal_handle,
    paneKey: principal.pane_key
  }
}
