import type { LegacyPaneKeyAliasEntry } from '../../../../shared/persisted-state-types'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { ProfileStateDatabaseQuarantine } from '../../profile-state/recovery/profile-state-database-quarantine'
import type { ProfileStateDomainPatch } from '../../profile-state/documents/profile-state-domain-patches'

export type PreparedProfileStateWrite = {
  domainOrder: readonly string[]
  replacements: readonly ProfileStateDomainReplacement[]
  patches: readonly ProfileStateDomainPatch[]
  runPayloads?: readonly string[]
  complete?: boolean
}

export type ProfileStateMaintenance = {
  resume(): Promise<void>
}

// Keep compatibility/offline persistence loadable without eagerly importing SQLite.
export type ProfileStateAuthority = {
  readonly asynchronous?: false
  /** Undefined means this authority has no saved state. */
  readSerializedState(): string | undefined

  assertCurrentRevision?: () => void

  /** Without selective domain writes, callers replace the full document. */
  writeSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  writePreparedState?: (write: PreparedProfileStateWrite) => void

  /** Commit definitions and run projections atomically without serializing unrelated domains. */
  writeSerializedAutomationRuns?: (
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ) => void

  /** Commit the full storage document; stale revisions may be rejected. */
  writeSerializedState(payload: Buffer): void

  /** Omitted domains and null payloads are deleted. */
  writeCompleteSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  scheduleBackup?: () => void

  drainBackups?: (cancel?: boolean) => Promise<void>

  writeJsonExport?: (targetPath: string) => number

  quarantineDatabase?: (quarantineRoot?: string, reason?: string) => ProfileStateDatabaseQuarantine

  close?: () => void

  /** Resume is permitted only after a clean maintenance close. */
  pauseForMaintenance?: () => Promise<ProfileStateMaintenance>
}

export type AsyncProfileStateAuthority = Omit<
  ProfileStateAuthority,
  | 'asynchronous'
  | 'assertCurrentRevision'
  | 'writeSerializedDomains'
  | 'writePreparedState'
  | 'writeSerializedAutomationRuns'
  | 'writeSerializedState'
  | 'writeCompleteSerializedDomains'
  | 'writeJsonExport'
  | 'quarantineDatabase'
  | 'close'
> & {
  readonly asynchronous: true
  assertWritable(): void
  abort(): Promise<void>
  assertCurrentRevision(): Promise<void>
  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): Promise<void>
  writePreparedState?: (write: PreparedProfileStateWrite) => Promise<void>
  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): Promise<void>
  writeSerializedState(payload: Buffer): Promise<void>
  writeCompleteSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void>
  writeJsonExport(targetPath: string): Promise<number>
  writeLatestJsonExport(dataFile: string): Promise<number | undefined>
  quarantineDatabase(
    quarantineRoot?: string,
    reason?: string
  ): Promise<ProfileStateDatabaseQuarantine>
  close(): Promise<void>
}

export type ProfileStatePersistenceAuthority = ProfileStateAuthority | AsyncProfileStateAuthority

export type ProfileStateDomainReplacement = {
  domain: string
  /** Null removes this domain. */
  payload: string | null
}

export type ProfileStateStartupPaneAlias = Omit<LegacyPaneKeyAliasEntry, 'ptyId'>

export type ProfileStateAuthorityInitialState<
  Authority extends ProfileStatePersistenceAuthority = ProfileStateAuthority
> = {
  readonly authority: Authority
  readonly unboundPaneAliases?: readonly ProfileStateStartupPaneAlias[]
} & (
  | { readonly serializedState: string | undefined; readonly takeParsedState?: never }
  | {
      readonly serializedState?: never
      /** Transfer this storage-form object once, before decryption or mutation. */
      readonly takeParsedState: () => Record<string, unknown> | undefined
    }
)
