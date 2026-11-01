/** Expose fenced-source checks/release through the cutover port; conversion owns terminal assessment, export and fence acquisition. */
import type { OrcadMigrationSourceKind } from '../../shared/orcad-migration/orcad-migration-source-kind'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { OrcadMigrationManifestExportOptions } from './orcad-migration-manifest-export'
import type {
  OrcadMigrationFenceResult,
  OrcadMigrationFenceState
} from './orcad-migration-source-fence'
import type { OrcadMigrationTerminalVerdict } from './orcad-migration-terminal-gate'

export type OrcadMigrationSourceCutoverPort = {
  /** Before every stage and commit; throws unless the fenced source still matches the journal. */
  verifyFence: (cutover: OrcadMigrationSourceCutover) => void
  /** Drops the fence, then the journal; only on proof the destination holds nothing. */
  releaseFence: (cutover: OrcadMigrationSourceCutover) => Promise<void>
}

type OrcadMigrationFenceAcquireArgs = {
  destinationEnvironmentId: string
  destinationName: string
  terminalProof: OrcadMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}

export type OrcadMigrationSource = OrcadMigrationSourceCutoverPort & {
  readonly kind: OrcadMigrationSourceKind
  readonly journalKey: string
  collectCatalog: () => OrcadMigrationCatalogPayload
  /** Rewrite paths before signing; export must not mutate source. */
  exportManifest: (options?: OrcadMigrationManifestExportOptions) => OrcadMigrationManifest
  /** Before the fence. Loss of contact is `unverifiable`, never `exited`. */
  assessTerminals: () => Promise<OrcadMigrationTerminalVerdict>
  retireProvenExitedTerminals: (proof: OrcadMigrationTerminalVerdict) => void
  /** Throws when the journal cannot be read: an unreadable record keeps the source fenced. */
  resolveFence: () => OrcadMigrationFenceState
  /** Journal, then fence, then flush, then the terminal re-check under the fence. */
  acquireFence: (args: OrcadMigrationFenceAcquireArgs) => Promise<OrcadMigrationFenceResult>
}
