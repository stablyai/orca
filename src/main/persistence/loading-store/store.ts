import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from '../../agent-hooks/migration-unsupported-pty-state'
import { agentHookServer } from '../../agent-hooks/server'
import { ActiveViewPreference } from '../../active-view-preference'
import { registerPersistedPaneKeyAlias } from '../restoring-sessions/pane-alias-normalization'
import { normalizePersistedPaneIdentityState } from '../restoring-sessions/workspace-pane-normalization'
import { StoreRuntimeState, type StoreRuntimeOptions } from './store-runtime-state'
import {
  createStoreDomains,
  installStoreDomainContexts,
  STORE_DOMAIN_OPERATION_CLASSES,
  type StoreDomains
} from './store-domain-composition'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { scheduleSave } from './write-scheduling'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueuePrimaryStateOperation, writeToDiskAsync } from './primary-state-writes'
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
import type { ProfileStateDatabaseQuarantine } from '../profile-state/profile-state-database-quarantine'
import { writeVersionedProfileStateExport } from '../profile-state/profile-state-versioned-export'
import {
  beginProfileStateMaintenance,
  freezeProfileStateWrites,
  freezeProfileStateWritesAsync,
  type ProfileStateMaintenanceOptions
} from './profile-state-maintenance'
import type {
  AsyncProfileStateAuthority,
  ProfileStateAuthorityInitialState,
  ProfileStatePersistenceAuthority,
  ProfileStateMaintenance
} from './profile-state-authority'

export type StoreOptions = StoreRuntimeOptions & {
  /** Storage-form JSON supplied by a read-only profile migration/import boundary. */
  serializedState?: string
  /** Reuse the authority's validated startup read without retaining a cached copy. */
  initialAuthorityState?: ProfileStateAuthorityInitialState<ProfileStatePersistenceAuthority>
}

export type PreparedProfileStateExport = {
  readonly json: string
  commit(): void
}
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
    if (options.profileStateAuthority !== undefined && options.serializedState !== undefined) {
      throw new Error('Store cannot use both a profile-state authority and serialized state')
    }
    if (
      options.initialAuthorityState !== undefined &&
      (options.profileStateAuthority === undefined ||
        options.initialAuthorityState.authority !== options.profileStateAuthority)
    ) {
      throw new Error('Store initial authority state must belong to its profile-state authority')
    }
    const initial = options.initialAuthorityState
    const parsedState = initial?.takeParsedState?.()
    this.runtime = new StoreRuntimeState(options)
    this.domains = createStoreDomains(this.runtime)
    installStoreDomainContexts(this, this.domains)
    this.runtime.flushOrThrow = () => this.flushOrThrow()
    this.runtime.runDurableMutation = (mutate) => this.runDurableMutation(mutate)
    let loaded: PersistedState
    if (options.profileStateAuthority !== undefined) {
      if (initial !== undefined) {
        loaded =
          initial.takeParsedState !== undefined
            ? this.domains.loader.loadParsedFromAuthority(parsedState)
            : this.domains.loader.loadFromAuthority(initial.serializedState)
      } else {
        loaded = this.domains.loader.loadFromAuthority(
          options.profileStateAuthority.readSerializedState()
        )
      }
    } else if (options.serializedState !== undefined) {
      loaded = this.domains.loader.loadSerialized(options.serializedState)
    } else {
      loaded = this.domains.loader.load()
    }
    const normalized = normalizePersistedPaneIdentityState(loaded)
    this.state = normalized.state
    this.runtime.state = this.state
    this.runtime.activeViewPreference = new ActiveViewPreference(
      this.runtime.dataFile,
      this.state.ui?.activeView
    )
    const adaptedProjectGroups = this.domains.adaptation.adaptFlatFolderScanProjectGroups()
    this.domains.adaptation.hydrateFolderWorkspaceDiffComments()
    // Load is the only place an orphaned repo id can be swept: every removal path needs the repo to
    // still be registered, so rows outlive their owner without one (#17776).
    const sweptRepoIds = this.domains.repos.sweepDeregisteredRepoResidue()
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
    if (
      normalized.changed ||
      this.runtime.loadNeedsSave ||
      adaptedProjectGroups ||
      sweptRepoIds.length > 0
    ) {
      scheduleSave(this.domains.scheduling)
    }
    // An imported source is not a legacy JSON authority. The caller must
    // commit through its database/export boundary instead of writing a file.
    if (options.serializedState !== undefined) {
      this.freezeWrites()
    }
  }

  getProfileStorageDirectory(): string {
    return dirname(this.runtime.dataFile)
  }

  /**
   * Prepare a storage-form export for a database importer.
   *
   * Secret retention is committed only after the caller durably accepts the
   * export. This keeps a failed migration from discarding the prior sealed
   * value from the in-memory fallback store.
   */
  prepareProfileStateExport(): PreparedProfileStateExport {
    const built = this.domains.serialization.buildStateToSave()
    let committed = false
    return {
      json: built.payload.toString('utf8'),
      commit: () => {
        if (committed) {
          return
        }
        this.runtime.protectedSecrets.commitRetentionUpdates(built.protectedSecretUpdates)
        committed = true
      }
    }
  }

  /** Publish an explicit rollback/compatibility export after flushing current state. */
  writeProfileStateJsonExport(targetPath: string): number | undefined {
    this.runtime.dirtyProfileStateDomains = null
    this.flushOrThrow()
    const authority = this.runtime.profileStateAuthority
    if (authority?.asynchronous) {
      throw new Error('Live profile exports require an awaited export')
    }
    if (authority?.writeJsonExport) {
      return authority.writeJsonExport(targetPath)
    }

    const prepared = this.prepareProfileStateExport()
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, prepared.json)
    prepared.commit()
    return undefined
  }

  /** Publish the latest SQLite revision as a durable, versioned rollback export. */
  writeLatestProfileStateJsonExport(): number | undefined {
    const authority = this.runtime.profileStateAuthority
    if (authority?.asynchronous) {
      throw new Error('Live profile exports require an awaited export')
    }
    if (!authority?.writeJsonExport) {
      return undefined
    }
    this.runtime.dirtyProfileStateDomains = null
    this.flushOrThrow()

    const writeExport = authority.writeJsonExport.bind(authority)
    return writeVersionedProfileStateExport(this.runtime.dataFile, writeExport)
  }

  /** Publish canonical JSON for a pre-update older-build compatibility window. */
  writeLatestProfileStateJsonCompatibilityExport(): number | undefined {
    const authority = this.runtime.profileStateAuthority
    if (authority?.asynchronous) {
      throw new Error('Live profile exports require an awaited export')
    }
    if (!authority?.writeJsonCompatibilityExport) {
      return undefined
    }
    this.runtime.dirtyProfileStateDomains = null
    this.flushOrThrow()
    return authority.writeJsonCompatibilityExport(this.runtime.dataFile)
  }

  writeLatestProfileStateJsonExportAsync(): Promise<number | undefined> {
    if (!this.runtime.profileStateAuthority?.asynchronous) {
      return Promise.resolve(this.writeLatestProfileStateJsonExport())
    }
    return this.enqueueProfileExport((authority) =>
      authority.writeLatestJsonExport(this.runtime.dataFile)
    )
  }

  writeLatestProfileStateJsonCompatibilityExportAsync(): Promise<number | undefined> {
    if (!this.runtime.profileStateAuthority?.asynchronous) {
      return Promise.resolve(this.writeLatestProfileStateJsonCompatibilityExport())
    }
    return this.enqueueProfileExport((authority) =>
      authority.writeJsonCompatibilityExport(this.runtime.dataFile)
    )
  }

  private enqueueProfileExport(
    exportState: (authority: AsyncProfileStateAuthority) => Promise<number | undefined>
  ): Promise<number | undefined> {
    if (
      this.runtime.writesFrozen ||
      this.runtime.quitFlushStarted ||
      this.runtime.profileMaintenancePending
    ) {
      return Promise.reject(new Error('Cannot export finalized profile persistence'))
    }
    const authority = this.runtime.profileStateAuthority
    if (!authority?.asynchronous) {
      return Promise.resolve(undefined)
    }
    return enqueuePrimaryStateOperation(this.domains.writes, async () => {
      this.runtime.dirtyProfileStateDomains = null
      if (!(await writeToDiskAsync(this.domains.writes))) {
        throw new Error('Profile state changed while preparing its export')
      }
      return exportState(authority)
    })
  }

  /** Freeze writes, then preserve the SQLite family for an explicit recovery decision. */
  quarantineProfileStateDatabase(
    quarantineRoot?: string,
    reason?: string
  ): ProfileStateDatabaseQuarantine {
    this.freezeWrites()
    const authority = this.runtime.profileStateAuthority
    if (authority?.asynchronous) {
      throw new Error('Live profile quarantine requires an awaited close')
    }
    if (!authority?.quarantineDatabase) {
      throw new Error('SQLite profile-state quarantine is unavailable')
    }
    return authority.quarantineDatabase(quarantineRoot, reason)
  }

  freezeWrites(): void {
    freezeProfileStateWrites(this.runtime)
  }

  beginProfileMaintenance(
    options?: ProfileStateMaintenanceOptions
  ): Promise<ProfileStateMaintenance> {
    return beginProfileStateMaintenance(this.runtime, this.domains, options)
  }

  freezeWritesAsync(): Promise<void> {
    return freezeProfileStateWritesAsync(this.runtime)
  }

  async quarantineProfileStateDatabaseAsync(
    quarantineRoot?: string,
    reason?: string
  ): Promise<ProfileStateDatabaseQuarantine> {
    await this.beginProfileMaintenance({ flush: false })
    const authority = this.runtime.profileStateAuthority
    if (!authority?.quarantineDatabase) {
      throw new Error('SQLite profile-state quarantine is unavailable')
    }
    return authority.quarantineDatabase(quarantineRoot, reason)
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
