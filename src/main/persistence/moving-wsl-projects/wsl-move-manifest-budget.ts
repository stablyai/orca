/**
 * A WSL move's manifest must fit one catalog request with room to spare: every stage, state and
 * abort carries it whole, and a reset that cannot carry it can only ask the host by identity.
 * Capping it when the move is recorded keeps new moves out of that gap entirely.
 */
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES } from '../../ssh/orcad-migration-manifest-export'

// Headroom for a host whose request limit is a little lower than this build's.
const WSL_MOVE_MANIFEST_MARGIN_BYTES = 16 * 1024

export const WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES =
  ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES - WSL_MOVE_MANIFEST_MARGIN_BYTES

export function wslMoveManifestRequestBytes(manifest: OrcadMigrationManifest): number {
  return Buffer.byteLength(JSON.stringify({ manifest }), 'utf8')
}

/** Throws the user-facing refusal before a move is recorded, so nothing is fenced. */
export function assertWslMoveManifestFits(manifest: OrcadMigrationManifest): void {
  const bytes = wslMoveManifestRequestBytes(manifest)
  if (bytes <= WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES) {
    return
  }
  const kib = (value: number): string => `${Math.ceil(value / 1024)} KiB`
  const projects = manifest.payload.repositories.length + manifest.payload.folderWorkspaces.length
  throw new Error(
    `wsl_move_manifest_too_large:The saved state of ${projects === 1 ? 'this project' : `these ${projects} projects`} ` +
      `is too large to move in one step (${kib(bytes)}, limit ${kib(WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES)}). ` +
      'Move fewer projects at a time, or close unused tabs and clear old terminal history first.'
  )
}
