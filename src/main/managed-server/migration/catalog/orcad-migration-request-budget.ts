import type { OrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { describeOversizedOrcadMigrationPayload } from './orcad-migration-payload-capacity'

// Request id, device token, method name and JSON framing around the params.
const REQUEST_ENVELOPE_RESERVE_BYTES = 1024

/** The largest catalog-request params that still fit the host's sealed inbound frame. */
export const ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES

/** Reject oversized manifest requests before fencing: stage/state/full abort would all exceed the sealed frame and close its socket. */
export function assertOrcadMigrationRequestFits(params: {
  manifest: OrcadMigrationManifest
}): void {
  if (!orcadMigrationRequestFits(params)) {
    throw new Error(
      describeOversizedOrcadMigrationPayload(
        params.manifest.payload,
        ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
      )
    )
  }
}

export function orcadMigrationRequestFits(params: { manifest: OrcadMigrationManifest }): boolean {
  return (
    Buffer.byteLength(JSON.stringify(params), 'utf8') <= ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
  )
}
