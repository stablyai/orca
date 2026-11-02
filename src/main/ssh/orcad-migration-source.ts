/**
 * Where a dormant catalog migrates out of, into a managed orcad.
 *
 * The destination half (catalog stage/commit and the cutover coordinator) reaches a source only
 * through `OrcadMigrationSourceCutoverPort`; the conversion drives the rest. The relay-era SSH
 * target (orcad-migration-ssh-relay-source.ts) is the only implementation.
 */
import type { OrcadMigrationSourceKind } from '../../shared/orcad-migration-source-kind'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { OrcadMigrationManifestExportOptions } from './orcad-migration-manifest-export'
import type {
  OrcadMigrationFenceResult,
  OrcadMigrationFenceState
} from './orcad-migration-source-fence'
import type { OrcadMigrationTerminalVerdict } from './orcad-migration-terminal-gate'

/** What a cutover needs from its source once fenced, keyed by the journaled cutover alone. */
export type OrcadMigrationSourceCutoverPort = {
  /** Before every stage and commit; throws unless the fenced source still matches the journal. */
  verifyFence: (cutover: OrcadMigrationSourceCutover) => void
  /** Drops the fence, then the journal; only on proof the destination holds nothing. */
  releaseFence: (cutover: OrcadMigrationSourceCutover) => Promise<void>
  /** After a proven commit: the source rows stay, hidden, for a downgraded build. */
  retireAfterCommit: (migrationId: string, now?: () => Date) => OrcadMigrationSourceCutover
}

export type OrcadMigrationFenceAcquireArgs = {
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by `assessTerminals` while the source could still answer. */
  terminalProof: OrcadMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}

export type OrcadMigrationSource = OrcadMigrationSourceCutoverPort & {
  readonly kind: OrcadMigrationSourceKind
  /** What every journal entry of this source is keyed by. */
  readonly journalKey: string
  /** Scope selection: the catalog rows this source owns. Read-only. */
  collectCatalog: () => OrcadMigrationCatalogPayload
  /** The signed manifest, after the source's path-rewrite stage. Read-only. */
  exportManifest: (options?: OrcadMigrationManifestExportOptions) => OrcadMigrationManifest
  /** Before the fence. Loss of contact is `unverifiable`, never `exited`. */
  assessTerminals: () => Promise<OrcadMigrationTerminalVerdict>
  /** Marks what an exited proof covers as ended, so later checks stop counting it. */
  retireProvenExitedTerminals: (proof: OrcadMigrationTerminalVerdict) => void
  /** Throws when the journal cannot be read: an unreadable record keeps the source fenced. */
  resolveFence: () => OrcadMigrationFenceState
  /** Journal, then fence, then flush, then the terminal re-check under the fence. */
  acquireFence: (args: OrcadMigrationFenceAcquireArgs) => Promise<OrcadMigrationFenceResult>
}
