/**
 * Arbitrating a managed request between the orcad acting on it and a client cancelling it.
 *
 * Both sides race to create one decision file per transaction with a hard link, which fails if
 * the file exists. Exactly one wins, and the loser reads the winner's decision, so a cancel can
 * never report success for a stop that orcad already began.
 */
import { linkSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  OrcadManagedStopDecisionSchema,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopDecision,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { orcadStopReceiptPath, readOrcadStopReceipt } from './orcad-completed-stop-receipt'

export type OrcadManagedStopDecisionValue = OrcadManagedStopDecision['decision']

function isAlreadyDecided(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

export function readOrcadManagedStopDecision(
  request: OrcadManagedStopRequest
): OrcadManagedStopDecisionValue | null {
  return readOrcadStopReceipt(request, 'decision', OrcadManagedStopDecisionSchema)?.decision ?? null
}

/** Returns the decision that stands: ours if we created it first, otherwise the other side's. */
export function claimOrcadManagedStopDecision(
  input: OrcadManagedStopRequest,
  decision: OrcadManagedStopDecisionValue
): OrcadManagedStopDecisionValue {
  const request = OrcadManagedStopRequestSchema.parse(input)
  const path = orcadStopReceiptPath(request, 'decision')
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`
  const record: OrcadManagedStopDecision = {
    schemaVersion: 1,
    kind: 'orcad_managed_stop_decision',
    request,
    decision
  }
  if (!writeDurableSecureJsonFile(staged, record)) {
    rmSync(staged, { force: true })
    throw new Error('orcad_managed_stop_decision_permissions_unconfirmed')
  }
  try {
    linkSync(staged, path)
    return decision
  } catch (error) {
    if (!isAlreadyDecided(error)) {
      throw error
    }
    const standing = readOrcadManagedStopDecision(request)
    if (!standing) {
      throw new Error('orcad_managed_stop_decision_unverifiable')
    }
    return standing
  } finally {
    rmSync(staged, { force: true })
  }
}
