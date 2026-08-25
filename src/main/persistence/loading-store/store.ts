import { dirname } from 'node:path'
import {
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from '../../agent-hooks/migration-unsupported-pty-state'
import { agentHookServer } from '../../agent-hooks/server'
import { ActiveViewPreference } from '../../active-view-preference'
import { registerPersistedPaneKeyAlias } from '../restoring-sessions/pane-alias-normalization'
import { normalizePersistedPaneIdentityState } from '../restoring-sessions/workspace-pane-normalization'
import { StoreRuntimeState } from './store-runtime-state'
import {
  createStoreDomains,
  installStoreDomainContexts,
  STORE_DOMAIN_OPERATION_CLASSES,
  type StoreDomains
} from './store-domain-composition'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { scheduleSave } from './write-scheduling'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import type { ProjectCollectionOperations } from './project-collection-operations'
import type { RepoLifecycleOperations } from './repo-lifecycle-operations'
import type { MobileTabSelectionPersistence } from './mobile-tab-selection-persistence'
import type { SparsePresetPersistence } from './sparse-preset-persistence'
import type { AutomationPersistence } from './automation-persistence'
import type { MetadataLineageOperations } from './metadata-lineage-operations'
import type { ProfilePreferences } from './profile-preferences'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { SessionSnapshotOperations } from './session-snapshot-operations'
import type { PtyBindingPersistenceOperations } from './pty-binding-persistence'
import type { SshProfileOperations } from './ssh-profile-operations'
import type { RetiredWorktreeNamePersistence } from './retired-worktree-name-persistence'
import type { SshLeaseRecoveryOperations } from './ssh-lease-recovery-operations'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'

export type StoreOptions = { dataFile?: string }
export type PtyBindingSourceExpectation = {
  worktreeId?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

/** Concrete composition root for profile persistence. */
// oxlint-disable-next-line typescript-eslint/no-unsafe-declaration-merging -- Store installs the exact concrete domain class descriptors and contexts below
export class Store {
  private readonly runtime: StoreRuntimeState
  private readonly domains: StoreDomains
  private readonly state: PersistedState

  constructor(options: StoreOptions = {}) {
    this.runtime = new StoreRuntimeState(options)
    this.domains = createStoreDomains(this.runtime)
    installStoreDomainContexts(this, this.domains)
    this.runtime.flushOrThrow = () => this.flushOrThrow()
    const loaded = this.domains.loader.load()
    const normalized = normalizePersistedPaneIdentityState(loaded)
    this.state = normalized.state
    this.runtime.state = this.state
    this.runtime.activeViewPreference = new ActiveViewPreference(
      this.runtime.dataFile,
      this.state.ui?.activeView
    )
    const adaptedProjectGroups = this.domains.adaptation.adaptFlatFolderScanProjectGroups()
    this.domains.adaptation.hydrateFolderWorkspaceDiffComments()
    for (const entry of normalized.migrationUnsupportedEntries) {
      setMigrationUnsupportedPty(entry)
    }
    for (const entry of normalized.legacyPaneKeyAliasEntries) {
      registerPersistedPaneKeyAlias(entry)
    }
    setMigrationUnsupportedPtyPersistenceListener((entries) => {
      this.state.migrationUnsupportedPtyEntries = entries
      scheduleSave(this.domains.scheduling)
    })
    agentHookServer.setPaneKeyAliasPersistenceListener((entries) => {
      this.state.legacyPaneKeyAliasEntries = entries
      scheduleSave(this.domains.scheduling)
    })
    if (normalized.changed || this.runtime.loadNeedsSave || adaptedProjectGroups) {
      scheduleSave(this.domains.scheduling)
    }
  }

  getProfileStorageDirectory(): string {
    return dirname(this.runtime.dataFile)
  }

  freezeWrites(): void {
    this.runtime.writesFrozen = true
    if (this.runtime.writeTimer) {
      clearTimeout(this.runtime.writeTimer)
      this.runtime.writeTimer = null
    }
  }
}

// oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging derives Store's prototype API directly from the exact concrete domain classes installed below
export interface Store
  extends
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
    WriteFlushBarrierOperations {}

for (const OperationClass of STORE_DOMAIN_OPERATION_CLASSES) {
  const descriptors = Object.getOwnPropertyDescriptors(OperationClass.prototype)
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (name !== 'constructor') {
      Object.defineProperty(Store.prototype, name, descriptor)
    }
  }
}
