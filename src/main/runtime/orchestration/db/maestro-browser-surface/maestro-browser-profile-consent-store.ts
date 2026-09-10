import type {
  MaestroBrowserProfileConsentGrantRequest,
  MaestroBrowserProfileConsentReceipt,
  MaestroBrowserProfileConsentRevokeRequest
} from '../../../../../shared/maestro-browser-surface'
import { MaestroBrowserProfileConsentReceiptSchema } from '../../../../../shared/maestro-browser-surface'
import type { MaestroActor, MaestroWorkspaceAnchor } from '../../../../../shared/maestro-contract'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

type BrowserProfileConsentRow = {
  consent_id: string
  receipt_json: string
  revoked_at: string | null
  created_at: string
  updated_at: string
}

function isoDate(value: string): string {
  return value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
}

function parseConsentRow(row: BrowserProfileConsentRow): MaestroBrowserProfileConsentReceipt {
  let receiptValue: unknown
  try {
    receiptValue = JSON.parse(row.receipt_json)
  } catch {
    throw new OrchestrationError(
      'browser_profile_consent_invalid',
      `Browser profile consent ${row.consent_id} has an invalid receipt.`
    )
  }
  return MaestroBrowserProfileConsentReceiptSchema.parse({
    ...MaestroBrowserProfileConsentReceiptSchema.parse(receiptValue),
    revoked_at: row.revoked_at ? isoDate(row.revoked_at) : null
  })
}

function sameConsentReceipt(
  left: MaestroBrowserProfileConsentReceipt,
  right: MaestroBrowserProfileConsentReceipt
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function getMaestroBrowserProfileConsent(
  this: OrchestrationDb,
  receipt: MaestroBrowserProfileConsentReceipt,
  workspace: Pick<MaestroWorkspaceAnchor, 'execution_host_id' | 'workspace_key' | 'run_id'>
): MaestroBrowserProfileConsentReceipt | undefined {
  const row = this.db
    .prepare(
      `SELECT consent_id, receipt_json, revoked_at, created_at, updated_at
       FROM maestro_browser_profile_consents
       WHERE consent_id = ? AND execution_host_id = ? AND workspace_key = ?
         AND run_id = ? AND task_id = ? AND attempt_id = ? AND profile_id = ?`
    )
    .get(
      receipt.consent_id,
      workspace.execution_host_id,
      workspace.workspace_key,
      workspace.run_id,
      receipt.task_id,
      receipt.attempt_id,
      receipt.profile_id
    ) as BrowserProfileConsentRow | undefined
  if (!row) {
    return undefined
  }
  const stored = parseConsentRow(row)
  return sameConsentReceipt(stored, receipt) ? stored : undefined
}

export function grantMaestroBrowserProfileConsent(
  this: OrchestrationDb,
  request: MaestroBrowserProfileConsentGrantRequest,
  grantedBy: MaestroActor & { kind: 'user' },
  now = new Date()
): MaestroBrowserProfileConsentReceipt {
  const activeRow = this.db
    .prepare(
      `SELECT consent_id, receipt_json, revoked_at, created_at, updated_at
       FROM maestro_browser_profile_consents
       WHERE execution_host_id = ? AND workspace_key = ? AND run_id = ?
         AND task_id = ? AND attempt_id = ? AND profile_id = ? AND revoked_at IS NULL`
    )
    .get(
      request.workspace.execution_host_id,
      request.workspace.workspace_key,
      request.workspace.run_id,
      request.task_id,
      request.attempt_id,
      request.profile_id
    ) as BrowserProfileConsentRow | undefined
  if (activeRow) {
    const active = parseConsentRow(activeRow)
    if (Date.parse(active.expires_at) > now.getTime()) {
      return active
    }
    const revokedAt = now.toISOString()
    this.db
      .prepare(
        `UPDATE maestro_browser_profile_consents
         SET receipt_json = ?, revoked_at = ?, updated_at = datetime('now')
         WHERE consent_id = ? AND revoked_at IS NULL`
      )
      .run(JSON.stringify({ ...active, revoked_at: revokedAt }), revokedAt, active.consent_id)
  }
  const receipt = MaestroBrowserProfileConsentReceiptSchema.parse({
    schema_version: 1,
    protocol: 'maestro-browser-profile-consent/v1',
    consent_id: generateId('browser-consent'),
    profile_id: request.profile_id,
    run_id: request.workspace.run_id,
    task_id: request.task_id,
    attempt_id: request.attempt_id,
    granted_by: grantedBy,
    granted_at: now.toISOString(),
    expires_at: request.expires_at,
    revoked_at: null
  })
  this.db
    .prepare(
      `INSERT INTO maestro_browser_profile_consents (
         consent_id, execution_host_id, workspace_key, run_id, task_id,
         attempt_id, profile_id, receipt_json, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      receipt.consent_id,
      request.workspace.execution_host_id,
      request.workspace.workspace_key,
      request.workspace.run_id,
      request.task_id,
      request.attempt_id,
      request.profile_id,
      JSON.stringify(receipt)
    )
  return receipt
}

export function revokeMaestroBrowserProfileConsent(
  this: OrchestrationDb,
  request: MaestroBrowserProfileConsentRevokeRequest,
  now = new Date()
): MaestroBrowserProfileConsentReceipt {
  const row = this.db
    .prepare(
      `SELECT consent_id, receipt_json, revoked_at, created_at, updated_at
       FROM maestro_browser_profile_consents
       WHERE consent_id = ? AND execution_host_id = ? AND workspace_key = ? AND run_id = ?`
    )
    .get(
      request.consent_id,
      request.workspace.execution_host_id,
      request.workspace.workspace_key,
      request.workspace.run_id
    ) as BrowserProfileConsentRow | undefined
  if (!row) {
    throw new OrchestrationError(
      'browser_profile_consent_not_found',
      `Browser profile consent ${request.consent_id} was not found.`
    )
  }
  const current = parseConsentRow(row)
  if (current.revoked_at !== null) {
    return current
  }
  const revokedAt = now.toISOString()
  const revoked = MaestroBrowserProfileConsentReceiptSchema.parse({
    ...current,
    revoked_at: revokedAt
  })
  this.db
    .prepare(
      `UPDATE maestro_browser_profile_consents
       SET receipt_json = ?, revoked_at = ?, updated_at = datetime('now')
       WHERE consent_id = ? AND revoked_at IS NULL`
    )
    .run(JSON.stringify(revoked), revokedAt, current.consent_id)
  return revoked
}
