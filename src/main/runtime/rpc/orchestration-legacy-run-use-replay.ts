import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { LegacyCoordinatorAuthorityProof, RpcRequest } from './core'
import { equivalentLegacyPaneKey } from './orchestration-legacy-process-identity'

export function resolveLegacyRunUseReplay(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  params: Record<string, unknown>
): LegacyCoordinatorAuthorityProof | undefined {
  if (request.method !== 'orchestration.runUse' || !request.orchestrationRequestId) {
    return undefined
  }
  const runId = stringValue(params.id)
  const evidence = request.orchestrationCompatibilityEvidence
  if (!runId || !evidence?.terminalHandle || !evidence.paneKey) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  const run = db.getRun(runId)
  const principal = db.getLegacyCoordinatorPrincipal(runId)
  if (
    !run ||
    !principal ||
    principal.status !== 'committed' ||
    run.coordinator_handle !== evidence.terminalHandle ||
    principal.terminal_handle !== evidence.terminalHandle ||
    !equivalentLegacyPaneKey(run.coordinator_pane_key, evidence.paneKey) ||
    !equivalentLegacyPaneKey(principal.pane_key, evidence.paneKey)
  ) {
    return undefined
  }
  const authority = {
    runId,
    principalId: principal.id,
    terminalHandle: principal.terminal_handle,
    paneKey: principal.pane_key,
    consumerGeneration: run.consumer_generation
  }
  return db.getMutationReceipt(
    legacyCoordinatorMutationCallerFingerprint(authority),
    request.orchestrationRequestId
  )
    ? authority
    : undefined
}

export function legacyCoordinatorMutationCallerFingerprint(
  authority: LegacyCoordinatorAuthorityProof
): string {
  return createHash('sha256')
    .update(
      ['legacy-coordinator-v1', authority.runId, authority.terminalHandle, authority.paneKey].join(
        '\0'
      )
    )
    .digest('hex')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
