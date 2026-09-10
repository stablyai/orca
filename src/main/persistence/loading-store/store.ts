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
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { syncProjectHostSetupCompatibilityState } from './repo-lifecycle-operations'
import { bumpLocalWorktreeScanGeneration } from '../../local-worktree-scan-generation'
import {
  planRepoPathRelocation,
  type RepoWorkspaceIdentityMove
} from '../tracking-repos/repo-path-relocation'
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

export type StoreOptions = StoreRuntimeOptions
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

  /**
   * Point a registered project at a directory it has moved to, carrying its workspaces across.
   *
   * Lives on the composition root because it is the one repo mutation that also has to re-key
   * worktree-derived identity: `updateRepo` cannot take `path` precisely because changing it alone
   * would strand every `<repoId>::<path>` row. Callers own validating that `newPath` exists on the
   * host that runs the project; this only rewrites persisted identity.
   */
  relocateRepoPath(
    repoId: string,
    newPath: string,
    hostId?: ExecutionHostId
  ): { repo: Repo; moves: RepoWorkspaceIdentityMove[] } | null {
    // Host-qualified like `updateRepo`: the same repo id can exist on several execution hosts, and an
    // id-only lookup would move one host's row using another host's request.
    const stored = this.state.repos.find(
      (candidate) =>
        candidate.id === repoId && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
    if (!stored) {
      return null
    }
    const moves = planRepoPathRelocation(this.state, stored, newPath)
    // Re-key first: a migration reads the old id, so the repo must still spell the old path.
    // No host argument, matching the folder-rename path: naming a host that disagrees with the row's
    // own persisted `hostId` makes the migration skip the session it was called to move.
    for (const move of moves) {
      this.migrateWorktreeIdentity(move.from, move.to)
    }
    stored.path = newPath
    // Project host setups are projected from the repo catalog, so a path written without this stays
    // stale on the setup row until an unrelated catalog mutation happens to rebuild it — and
    // `setup.path` is what an automation resolves its run directory from.
    syncProjectHostSetupCompatibilityState(this)
    // Every path a scan would report just changed, which is exactly what this generation exists to
    // signal. `updateRepo` bumps it for far smaller edits; a direct write must not skip it.
    bumpLocalWorktreeScanGeneration(repoId)
    scheduleSave(this.domains.scheduling)
    return { repo: this.getRepo(repoId) ?? stored, moves }
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
