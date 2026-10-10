import type { StoreRuntimeState } from './store-runtime-state'
import type { Store } from './store'
import { LoadedStateAdaptationOperations } from './loaded-state-adaptation'
import { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'
import { LoadedStateParsingOperations } from './loaded-state-parsing'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import { PrimaryStateWriteOperations } from './primary-state-writes'
import { WriteSchedulingOperations } from './write-scheduling'
import { WriteFlushBarrierOperations } from './write-flush-barriers'
import { ProfilePreferences } from './profile-preferences'
import { RepoLifecycleOperations } from './repo-lifecycle-operations'
import { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import { SessionHostPartitionOperations } from './session-host-partitions'
import { SessionSnapshotOperations } from './session-snapshot-operations'
import { MetadataLineageOperations } from './metadata-lineage-operations'
import { ProjectCollectionOperations } from './project-collection-operations'
import { AutomationPersistence } from './automation-persistence'
import { MobileTabSelectionPersistence } from './mobile-tab-selection-persistence'
import { SparsePresetPersistence } from './sparse-preset-persistence'
import { PtyBindingPersistenceOperations } from './pty-binding-persistence'
import { SshProfileOperations } from './ssh-profile-operations'
import { RetiredWorktreeNamePersistence } from './retired-worktree-name-persistence'
import { SshLeaseRecoveryOperations } from './ssh-lease-recovery-operations'
import { OrcadSourceExportPersistence } from '../migrating-orcad-catalog/orcad-source-export'
import { OrcadCatalogImportPersistence } from '../migrating-orcad-catalog/orcad-catalog-import'

export type StoreDomainOperations = WriteSchedulingOperations &
  PrimaryStateWriteOperations &
  ProjectCollectionOperations &
  RepoLifecycleOperations &
  MobileTabSelectionPersistence &
  SparsePresetPersistence &
  AutomationPersistence &
  MetadataLineageOperations &
  ProfilePreferences &
  SessionHostPartitionOperations &
  SessionSnapshotOperations &
  PtyBindingPersistenceOperations &
  SshProfileOperations &
  RetiredWorktreeNamePersistence &
  SshLeaseRecoveryOperations &
  OrcadSourceExportPersistence &
  OrcadCatalogImportPersistence &
  WriteFlushBarrierOperations

export type StoreDomains = {
  adaptation: LoadedStateAdaptationOperations
  cohorts: LoadedCohortMigrationOperations
  loader: LoadedStateParsingOperations
  serialization: StateSerializationSecretHandlingOperations
  writes: PrimaryStateWriteOperations
  scheduling: WriteSchedulingOperations
  flushBarriers: WriteFlushBarrierOperations
  preferences: ProfilePreferences
  repos: RepoLifecycleOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  sessions: SessionHostPartitionOperations
  sessionSnapshots: SessionSnapshotOperations
  metadata: MetadataLineageOperations
  projects: ProjectCollectionOperations
  automations: AutomationPersistence
  mobileTabSelections: MobileTabSelectionPersistence
  sparsePresets: SparsePresetPersistence
  ptyBindings: PtyBindingPersistenceOperations
  sshProfiles: SshProfileOperations
  retiredWorktreeNames: RetiredWorktreeNamePersistence
  sshLeases: SshLeaseRecoveryOperations
  orcadSourceExport: OrcadSourceExportPersistence
  orcadCatalogImports: OrcadCatalogImportPersistence
}

export const STORE_DOMAIN_OPERATION_CLASSES = [
  WriteSchedulingOperations,
  PrimaryStateWriteOperations,
  ProjectCollectionOperations,
  RepoLifecycleOperations,
  MobileTabSelectionPersistence,
  SparsePresetPersistence,
  AutomationPersistence,
  MetadataLineageOperations,
  ProfilePreferences,
  SessionHostPartitionOperations,
  SessionSnapshotOperations,
  PtyBindingPersistenceOperations,
  SshProfileOperations,
  RetiredWorktreeNamePersistence,
  SshLeaseRecoveryOperations,
  OrcadSourceExportPersistence,
  OrcadCatalogImportPersistence,
  WriteFlushBarrierOperations
] as const

export function installStoreDomainContexts(target: Store, domains: StoreDomains): void {
  // Each domain keeps its context under a module-private Symbol; the Store mixes in the domain methods, so it needs those symbols too.
  for (const domain of Object.values(domains)) {
    for (const key of Object.getOwnPropertySymbols(domain)) {
      const { value } = Object.getOwnPropertyDescriptor(domain, key) ?? {}
      Object.defineProperty(target, key, { value })
    }
  }
}

export function createStoreDomains(runtime: StoreRuntimeState): StoreDomains {
  const adaptation = new LoadedStateAdaptationOperations(runtime)
  const cohorts = new LoadedCohortMigrationOperations(runtime)
  const loader = new LoadedStateParsingOperations(runtime, cohorts)
  const serialization = new StateSerializationSecretHandlingOperations(runtime)
  const writes = new PrimaryStateWriteOperations(runtime, serialization)
  const scheduling = new WriteSchedulingOperations(runtime, writes)
  const flushBarriers = new WriteFlushBarrierOperations(runtime, writes)
  const preferences = new ProfilePreferences(runtime, scheduling)
  const repos = new RepoLifecycleOperations(runtime, scheduling)
  const bindingRecovery = new TerminalBindingRecoveryOperations(runtime)
  const sessions = new SessionHostPartitionOperations(runtime, scheduling, bindingRecovery)
  const sessionSnapshots = new SessionSnapshotOperations(
    runtime,
    sessions,
    bindingRecovery,
    scheduling
  )
  const metadata = new MetadataLineageOperations(runtime, scheduling, sessions)
  const projects = new ProjectCollectionOperations(runtime, repos, scheduling, metadata)
  const automations = new AutomationPersistence(runtime, flushBarriers, preferences)
  const mobileTabSelections = new MobileTabSelectionPersistence(runtime, scheduling)
  const sparsePresets = new SparsePresetPersistence(runtime, scheduling)
  const ptyBindings = new PtyBindingPersistenceOperations(runtime, sessions)
  const sshProfiles = new SshProfileOperations(runtime, scheduling, repos)
  const retiredWorktreeNames = new RetiredWorktreeNamePersistence(runtime, scheduling)
  const sshLeases = new SshLeaseRecoveryOperations(
    runtime,
    flushBarriers,
    bindingRecovery,
    scheduling
  )
  const orcadCatalogImports = new OrcadCatalogImportPersistence(runtime, repos, scheduling)
  return {
    adaptation,
    cohorts,
    loader,
    serialization,
    writes,
    scheduling,
    flushBarriers,
    preferences,
    repos,
    bindingRecovery,
    sessions,
    sessionSnapshots,
    metadata,
    projects,
    automations,
    mobileTabSelections,
    sparsePresets,
    ptyBindings,
    sshProfiles,
    retiredWorktreeNames,
    sshLeases,
    // Read-only: holds the runtime state and nothing that writes.
    orcadSourceExport: new OrcadSourceExportPersistence(runtime),
    orcadCatalogImports
  }
}
