import {
  ToknSyncRowSchema,
  ToknTrackingSchema,
  type ToknSyncRow,
  type ToknTracking,
  type ToknUploadPreview
} from '../../shared/tokn-sync-status'

/** What tokn publishing reads from the usage service, which runs in its own process. */
export type ToknUsageReader = {
  readTracking(): Promise<ToknTracking>
  readRows(): Promise<ToknSyncRow[]>
}

type PrivilegedUsageCall = (method: string, params: unknown, explicit: boolean) => Promise<unknown>

export function createToknUsageReader(call: PrivilegedUsageCall): ToknUsageReader {
  return {
    // Status polls must not force a restart of a failing backend; only uploads ask for one.
    readTracking: async () =>
      ToknTrackingSchema.parse(await call('tokn:getTracking', undefined, false)),
    readRows: async () =>
      ToknSyncRowSchema.array()
        .max(20_000)
        .parse(await call('tokn:getRows', undefined, true))
  }
}

/** The exact request body, shared by the upload and its preview. */
export async function buildToknUploadBody(
  usage: ToknUsageReader,
  appVersion: string
): Promise<ToknUploadPreview['body']> {
  const rows = await usage.readRows()
  // Read after the scan: a tool whose tracking was turned off meanwhile contributes no rows.
  const tracking = await usage.readTracking()
  return {
    rows: rows.filter((row) => (row.tool === 'codex' ? tracking.codex : tracking.claude)),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scannedAt: new Date().toISOString(),
    cliVersion: appVersion
  }
}
