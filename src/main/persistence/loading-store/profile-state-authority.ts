import type { AutomationRun } from '../../../shared/automations-types'
import type { ProfileStateDatabaseQuarantine } from '../profile-state/profile-state-database-quarantine'

/**
 * The primary profile-state boundary used by Store.
 *
 * The legacy implementation is still the default. Keeping this contract
 * independent of SQLite lets the Node 18 orcad bundle load Store without
 * eagerly loading a newer runtime's `node:sqlite` module.
 */
export type ProfileStateAuthority = {
  /** Return storage-form JSON, or undefined when this authority has no state yet. */
  readSerializedState(): string | undefined

  /** Fence a hash-identical checkpoint without rereading or rewriting its payload. */
  assertCurrentRevision?: () => void

  /**
   * Optionally commit only the explicitly dirty top-level domains. Authorities
   * without this capability retain the complete-document fallback below.
   */
  writeSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  /**
   * Commit automation definition replacements and the changed run projection
   * in one profile-revision transaction without serializing unrelated domains.
   */
  writeSerializedAutomationRuns?: (
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ) => void

  /**
   * Durably replace the complete storage-form document. Implementations may
   * reject a stale read instead of allowing last-writer-wins replacement.
   */
  writeSerializedState(payload: Buffer): void

  /** Replace the whole profile; omitted domains and null payloads are deleted. */
  writeCompleteSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  /** Schedule bounded recovery protection after a successful primary commit. */
  scheduleBackup?: () => void

  /** Drain owned backup handles before shutdown or profile file mutations. */
  drainBackups?: () => Promise<void>

  /** Optionally publish a durable JSON export for rollback or a compatibility runtime. */
  writeJsonExport?: (targetPath: string) => number

  /** Publish canonical JSON for an older build and advance its SQLite acceptance marker. */
  writeJsonCompatibilityExport?: (targetPath: string) => number | undefined

  /** Refresh compatibility JSON after the final flush with asynchronous JSON file writes. */
  writeJsonCompatibilityExportAsync?: (targetPath: string) => Promise<number | undefined>

  /** Optionally preserve the database family before an explicit recovery decision. */
  quarantineDatabase?: (quarantineRoot?: string, reason?: string) => ProfileStateDatabaseQuarantine

  /** Release any process-local database handle before a profile is switched or removed. */
  close?: () => void
}

export type ProfileStateDomainReplacement = {
  domain: string
  /** Storage-form JSON for the domain, or null to remove its row. */
  payload: string | null
}

/** A startup read paired with the authority that observed its revision. */
export type ProfileStateAuthorityInitialState = {
  readonly authority: ProfileStateAuthority
} & (
  | { readonly serializedState: string | undefined; readonly takeParsedState?: never }
  | {
      readonly serializedState?: never
      /** Transfer this storage-form object once, before the loader can decrypt or mutate it. */
      readonly takeParsedState: () => Record<string, unknown> | undefined
    }
)
