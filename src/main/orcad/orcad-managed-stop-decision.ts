// Exclusive hard links arbitrate stop versus cancel; cancel cannot succeed once dispatch wins.
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
import { hasErrorCode } from '../daemon/daemon-process-inspection'

type OrcadManagedStopDecisionValue = OrcadManagedStopDecision['decision']

export function readOrcadManagedStopDecision(
  request: OrcadManagedStopRequest
): OrcadManagedStopDecisionValue | null {
  return readOrcadStopReceipt(request, 'decision', OrcadManagedStopDecisionSchema)?.decision ?? null
}

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
    if (!hasErrorCode(error, 'EEXIST')) {
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
