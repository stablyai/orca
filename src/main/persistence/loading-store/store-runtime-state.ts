import { removeStaleDurableWriteTempFiles } from '../../durable-file-write'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ActiveViewPreference } from '../../active-view-preference'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { getDataFile, getGithubCacheFile } from './user-data-path'
import { STALE_DURABLE_WRITE_TEMP_AGE_MS } from '../tracking-repos/worktree-metadata-normalization'
import type { ProjectGroupPersistenceOperations } from '../tracking-repos/project-group-operations'
import type { FolderWorkspacePersistenceOperations } from '../restoring-sessions/folder-workspace-operations'
import type { RepoOrderPersistenceOperations } from '../tracking-repos/repo-order-operations'
import type { ProjectHostPersistenceOperations } from '../tracking-repos/project-host-operations'
import type { RepoUpdatePersistenceOperations } from '../tracking-repos/repo-update-operations'
import type { ProjectHostSetupPersistenceOperations } from '../tracking-repos/project-host-setup-update'
import type {
  AutomationListProjectionCache,
  AutomationStorageAuthority
} from '../scheduling-automations/automation-owner-projection'
import type { ProfileStatePersistenceAuthority } from './profile-state-authority'
import type { AutomationRun } from '../../../shared/automations-types'

export type DurableProfileStateMutation<T> = {
  value: T
  /** 'if-dirty' fences an existing change without rewriting an already durable generation. */
  persist?: boolean | 'if-dirty'
  rollback?: () => void
}

export type StoreRuntimeOptions = {
  dataFile?: string
  storageAuthority?: AutomationStorageAuthority
  profileStateAuthority?: ProfileStatePersistenceAuthority
}

/** Mutable coordination state shared only with this Store's private collaborators. */
export class StoreRuntimeState {
  state!: PersistedState
  readonly dataFile: string
  readonly storageAuthority: AutomationStorageAuthority
  readonly profileStateAuthority: ProfileStatePersistenceAuthority | undefined
  automationListProjectionCache: AutomationListProjectionCache | null = null
  activeViewPreference!: ActiveViewPreference
  readonly terminalScrollbackSnapshotStorage: TerminalScrollbackSnapshotStorage
  writeTimer: ReturnType<typeof setTimeout> | null = null
  pendingWrite: Promise<void> | null = null
  pendingSnapshotFileWork: Promise<void> | null = null
  readonly staleTempCleanup: Promise<void>
  writeGeneration = 0
  inFlightAsyncTmpFile: string | null = null
  backupRotationInFlight = false
  writesFrozen = false
  durableMutationPhase: 'mutate' | 'rollback' | null = null
  profileMaintenancePending = false
  pendingProfileMaintenance: Promise<void> | null = null
  readonly pendingProfileFlushes = new Set<Promise<void>>()
  quitFlushStarted = false
  quitFlushPromise: Promise<void> | null = null
  lastWrittenStateHash: string | null = null
  lastDurableWriteGeneration = -1
  firstPendingSaveAt: number | null = null
  /** Known dirty domains, or null when a caller requires a complete-document fallback. */
  dirtyProfileStateDomains: Set<string> | null = new Set()
  pendingAutomationRunsAfter: readonly AutomationRun[] | undefined
  githubCacheDirty = false
  githubCacheGeneration = 0
  pendingGithubCacheWrite: Promise<void> | null = null
  readonly staleGithubCacheTempCleanup: Promise<void>
  readonly gitUsernameCache = new Map<string, string>()
  readonly protectedSecrets = new ProtectedSecretPersistence()
  loadNeedsSave = false
  flushOrThrow!: () => void
  runDurableMutation!: <T>(mutate: () => DurableProfileStateMutation<T>) => Promise<T>
  settingsChangeListeners = new Set<
    (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  >()
  uiChangeListeners = new Set<(ui: PersistedState['ui']) => void>()
  projectHostOperations: ProjectHostPersistenceOperations | null = null
  projectGroupOperations: ProjectGroupPersistenceOperations | null = null
  folderWorkspaceOperations: FolderWorkspacePersistenceOperations | null = null
  repoOrderOperations: RepoOrderPersistenceOperations | null = null
  repoUpdateOperations: RepoUpdatePersistenceOperations | null = null
  projectHostSetupOperations: ProjectHostSetupPersistenceOperations | null = null

  constructor(options: StoreRuntimeOptions = {}) {
    this.dataFile = options.dataFile ?? getDataFile()
    this.storageAuthority = options.storageAuthority ?? 'desktop'
    this.profileStateAuthority = options.profileStateAuthority
    this.staleTempCleanup = removeStaleDurableWriteTempFiles(this.dataFile, {
      minimumAgeMs: STALE_DURABLE_WRITE_TEMP_AGE_MS
    })
    this.staleGithubCacheTempCleanup = removeStaleDurableWriteTempFiles(
      getGithubCacheFile(this.dataFile),
      { minimumAgeMs: STALE_DURABLE_WRITE_TEMP_AGE_MS }
    )
    const profileSnapshotRoot = getProfileTerminalScrollbackSnapshotRoot(this.dataFile)
    const legacySnapshotRoot = getProfileTerminalScrollbackSnapshotRoot(getDataFile())
    this.terminalScrollbackSnapshotStorage = {
      snapshotRoot: profileSnapshotRoot,
      fallbackSnapshotRoot: legacySnapshotRoot === profileSnapshotRoot ? null : legacySnapshotRoot
    }
  }
}
