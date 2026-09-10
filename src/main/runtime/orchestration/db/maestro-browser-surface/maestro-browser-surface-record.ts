import type {
  MaestroBrowserSurfaceReceipt,
  MaestroBrowserSurfaceRequest
} from '../../../../../shared/maestro-browser-surface'
import { MaestroBrowserSurfaceReceiptSchema } from '../../../../../shared/maestro-browser-surface'
import { OrchestrationError } from '../../orchestration-error'

export type BrowserSurfaceRow = {
  surface_id: string
  request_id: string
  execution_host_id: string
  workspace_key: string
  run_id: string
  task_id: string
  attempt_id: string
  agent_id: string
  owner_principal: string
  ownership: 'harness' | 'user'
  browser_page_id: string | null
  navigation_url: string
  state: MaestroBrowserSurfaceReceipt['state']
  retention: MaestroBrowserSurfaceReceipt['retention']
  receipt_json: string
  created_at: string
  updated_at: string
}

export type MaestroBrowserSurfaceRecord = {
  receipt: MaestroBrowserSurfaceReceipt
  navigationUrl: string
}

function isoDate(value: string): string {
  return value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
}

export function publicBrowserUrl(value: string): { url: string; origin: string } {
  const parsed = new URL(value)
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.toString(), origin: parsed.origin }
}

export function parseBrowserSurfaceRow(row: BrowserSurfaceRow): MaestroBrowserSurfaceRecord {
  let receiptValue: unknown
  try {
    receiptValue = JSON.parse(row.receipt_json)
  } catch {
    throw new OrchestrationError(
      'browser_surface_receipt_invalid',
      `Browser surface ${row.surface_id} has an invalid receipt.`
    )
  }
  const storedReceipt = MaestroBrowserSurfaceReceiptSchema.parse(receiptValue)
  const receipt = MaestroBrowserSurfaceReceiptSchema.parse({
    ...storedReceipt,
    browser_page_id: row.browser_page_id,
    state: row.state,
    retention: row.retention,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at)
  })
  return { receipt, navigationUrl: row.navigation_url }
}

export function assertSameBrowserSurfaceRequest(
  receipt: MaestroBrowserSurfaceReceipt,
  request: MaestroBrowserSurfaceRequest
): void {
  if (
    receipt.run_id !== request.workspace.run_id ||
    receipt.execution_host_id !== request.workspace.execution_host_id ||
    receipt.workspace_key !== request.workspace.workspace_key ||
    receipt.task_id !== request.task_id ||
    receipt.attempt_id !== request.attempt_id ||
    receipt.agent_id !== request.agent_id ||
    receipt.owner_principal !== request.actor.actor_id ||
    receipt.ownership !== request.ownership ||
    receipt.requested_visibility !== request.requested_visibility ||
    receipt.retention !== request.retention ||
    receipt.profile_id !== request.profile_id
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Browser surface request ${request.request_id} is already bound to another identity.`
    )
  }
}
