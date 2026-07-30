import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type { LegacyCompatibilityPrincipalRow } from '../orchestration/types'
import type { LegacyCoordinatorAuthorityProof, RpcRequest } from './core'
import {
  resolveAttestedLegacyPrincipal,
  verifyAttestedLegacyCandidate,
  type LegacyPrincipalCandidate
} from './orchestration-legacy-authority'
import {
  equivalentLegacyPaneKey,
  legacyCoordinatorReadOnly
} from './orchestration-legacy-process-identity'

export class LegacyCoordinatorAuthority {
  constructor(private readonly runtime: OrcaRuntimeService) {}

  resolve(
    request: RpcRequest,
    requestedRunId?: string
  ): LegacyCoordinatorAuthorityProof | undefined {
    const db = this.runtime.getOrchestrationDb()
    const adoption = db.getLegacyAdoption()
    const requestedRun = requestedRunId ?? adoption?.adopted_run_id
    if (!adoption || requestedRun !== adoption.adopted_run_id) {
      return undefined
    }
    const candidate = db.resolveLegacyCoordinatorCandidate({
      runId: adoption.adopted_run_id,
      terminalHandle: request.orchestrationCompatibilityEvidence?.terminalHandle,
      paneKey: request.orchestrationCompatibilityEvidence?.paneKey
    })
    if (!candidate) {
      if (request.orchestrationCompatibilityEvidence) {
        const caller = this.runtime.verifyOrchestrationCompatibilityCaller(
          request.orchestrationCompatibilityEvidence
        )
        const run = db.getRun(adoption.adopted_run_id)
        if (
          caller &&
          run?.coordinator_handle === caller.terminalHandle &&
          run.coordinator_pane_key &&
          equivalentLegacyPaneKey(run.coordinator_pane_key, caller.paneKey)
        ) {
          return undefined
        }
        throw legacyCoordinatorReadOnly()
      }
      return undefined
    }
    const existing = db.getLegacyCoordinatorPrincipal(adoption.adopted_run_id)
    const proofCandidate = existing
      ? this.candidate(adoption.adopted_run_id, existing)
      : this.candidate(adoption.adopted_run_id, candidate)
    const attestation = verifyAttestedLegacyCandidate({
      runtime: this.runtime,
      evidence: request.orchestrationCompatibilityEvidence,
      candidate: proofCandidate
    })
    const run = db.getRun(adoption.adopted_run_id)
    if (!run || !this.bindingMatches(run, proofCandidate)) {
      throw legacyCoordinatorReadOnly()
    }
    if (existing && !this.principalMatchesAttestation(existing, attestation)) {
      throw legacyCoordinatorReadOnly()
    }
    const principal = existing
      ? existing
      : request.method === 'orchestration.runUse'
        ? resolveAttestedLegacyPrincipal({
            runtime: this.runtime,
            evidence: request.orchestrationCompatibilityEvidence,
            candidate: proofCandidate,
            authority: attestation
          })
        : undefined
    return {
      runId: run.id,
      principalId: principal?.id ?? null,
      terminalHandle: proofCandidate.terminalHandle,
      paneKey: proofCandidate.paneKey,
      consumerGeneration: run.consumer_generation
    }
  }

  revalidate(request: RpcRequest, proof: LegacyCoordinatorAuthorityProof): string {
    const db = this.runtime.getOrchestrationDb()
    const adoption = db.getLegacyAdoption()
    const run = db.getRun(proof.runId)
    if (
      adoption?.adopted_run_id !== proof.runId ||
      !run ||
      run.consumer_generation !== proof.consumerGeneration
    ) {
      throw legacyCoordinatorReadOnly()
    }
    const candidate = this.candidate(proof.runId, proof)
    const principal = db.getLegacyCoordinatorPrincipal(proof.runId)
    if (proof.principalId) {
      if (
        principal?.id !== proof.principalId ||
        principal.status !== 'committed' ||
        principal.terminal_handle !== proof.terminalHandle ||
        !equivalentLegacyPaneKey(principal.pane_key, proof.paneKey)
      ) {
        throw legacyCoordinatorReadOnly()
      }
    } else if (
      principal &&
      (principal.status !== 'committed' ||
        principal.terminal_handle !== proof.terminalHandle ||
        !equivalentLegacyPaneKey(principal.pane_key, proof.paneKey))
    ) {
      throw legacyCoordinatorReadOnly()
    }
    const attestation = verifyAttestedLegacyCandidate({
      runtime: this.runtime,
      evidence: request.orchestrationCompatibilityEvidence,
      candidate
    })
    if (principal && !this.principalMatchesAttestation(principal, attestation)) {
      throw legacyCoordinatorReadOnly()
    }
    if (!this.bindingMatches(run, candidate)) {
      throw legacyCoordinatorReadOnly()
    }
    return run.id
  }

  private candidate(
    runId: string,
    identity: {
      terminalHandle?: string
      terminal_handle?: string
      paneKey?: string
      pane_key?: string
    }
  ): LegacyPrincipalCandidate {
    return {
      runId,
      role: 'coordinator',
      terminalHandle: identity.terminalHandle ?? (identity.terminal_handle as string),
      paneKey: identity.paneKey ?? (identity.pane_key as string)
    }
  }

  private bindingMatches(
    run: { coordinator_handle: string | null; coordinator_pane_key: string | null },
    candidate: LegacyPrincipalCandidate
  ): boolean {
    return (
      !run.coordinator_pane_key ||
      (run.coordinator_handle === candidate.terminalHandle &&
        equivalentLegacyPaneKey(run.coordinator_pane_key, candidate.paneKey))
    )
  }

  private principalMatchesAttestation(
    principal: LegacyCompatibilityPrincipalRow,
    attestation: OrchestrationCompatibilityCallerAuthority
  ): boolean {
    return (
      principal.status === 'committed' &&
      principal.host_scope === JSON.stringify(attestation.hostScope) &&
      principal.terminal_handle === attestation.terminalHandle &&
      equivalentLegacyPaneKey(principal.pane_key, attestation.paneKey) &&
      principal.launch_token_hash === attestation.launchTokenHash &&
      principal.process_incarnation === attestation.processIncarnation
    )
  }
}
