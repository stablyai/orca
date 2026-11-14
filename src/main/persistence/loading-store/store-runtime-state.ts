import { randomUUID } from 'node:crypto'
import { removeStaleDurableWriteTempFiles } from '../../filesystem/durable-file-write'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  WorkspaceSessionOperationListener,
  WorkspaceSessionWriteListener
} from './workspace-sessions/workspace-session-write-listeners'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  StateWriteListener,
  WorktreeMetaWriteListener
} from './profile-writing/write-scheduling'
import type { PartitionEditorViews } from './workspace-sessions/layout-editor-views'
import type { ActiveViewPreference } from '../preferences/active-view-preference'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../pty/scrollback/terminal-scrollback-snapshots'
import { ProtectedSecretPersistence } from '../../credentials/protected-secret-persistence'
import { getDataFile, getGithubCacheFile } from './user-data-path'
import { dirname, join } from 'node:path'
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
import type { ProfileStatePersistenceAuthority } from './profile-writing/profile-state-authority'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { resolveNewPaneShellPath } from '../migrating-orcad-catalog/terminal-history/orcad-shell-history-installer'
import { OrcadTerminalRestoreHintStore } from '../migrating-orcad-catalog/terminal-history/orcad-terminal-restore-hint-store'
import { ProfileStateSaveIntent } from './profile-writing/profile-state-save-intent'
import { WorkspaceSessionFieldCapture } from './profile-writing/profile-state-split-snapshots'

export type DurableProfileStateMutation<T> = {
  value: T
  /** if-dirty fences prior changes without rewriting a durable generation. */
  persist?: boolean | 'if-dirty'
  rollback?: () => void
  /** Absent means any host may have changed; otherwise notify only listed partitions. */
  writtenHostIds?: readonly ExecutionHostId[]
}

export type StoreRuntimeOptions = {
  dataFile?: string
  storageAuthority?: AutomationStorageAuthority
  profileStateAuthority?: ProfileStatePersistenceAuthority
  paneShellPath?: (defaultShell: string | undefined) => string
}

export class StoreRuntimeState {
  state!: PersistedState
  readonly dataFile: string
  readonly storageAuthority: AutomationStorageAuthority
  readonly profileStateAuthority: ProfileStatePersistenceAuthority | undefined
  readonly paneShellPath: (defaultShell: string | undefined) => string
  readonly deferredShellHistoryWorktreeIds = new Set<string>()
  automationListProjectionCache: AutomationListProjectionCache | null = null
  activeViewPreference!: ActiveViewPreference
  readonly terminalScrollbackSnapshotStorage: TerminalScrollbackSnapshotStorage
  readonly orcadMigrationBlobRoot: string
  readonly orcadTerminalRestoreHints: OrcadTerminalRestoreHintStore
  /** Retain exported scrollback blobs until their in-flight migrations finish reading. */
  readonly retainedScrollbackRefsByMigrationId = new Map<string, ReadonlySet<string>>()
  writeTimer: ReturnType<typeof setTimeout> | null = null
  pendingWrite: Promise<void> | null = null
  pendingSnapshotFileWork: Promise<void> | null = null
  writeGeneration = 0
  writesFrozen = false
  fatalMutationError: Error | null = null
  durableMutationPhase: 'mutate' | 'rollback' | null = null
  profileMaintenancePending = false
  pendingProfileMaintenance: Promise<void> | null = null
  readonly pendingProfileFlushes = new Set<Promise<void>>()
  quitFlushStarted = false
  quitFlushPromise: Promise<void> | null = null
  lastWrittenStateHash: string | null = null
  readonly workspaceSessionFieldCapture = new WorkspaceSessionFieldCapture()
  lastDurableWriteGeneration = -1
  /** Required durable generation for locally committed migrations; disk-loaded receipts have no entry. */
  readonly orcadMigrationCommitWriteGenerations = new Map<string, number>()
  firstPendingSaveAt: number | null = null
  /** Null requests complete-document fallback. */
  dirtyProfileStateDomains: Set<string> | null = new ProfileStateSaveIntent()
  pendingAutomationRunsAfter: readonly AutomationRun[] | undefined
  githubCacheDirty = false
  githubCachePersistedAt = Date.now()
  githubCachePersistTimer: ReturnType<typeof setTimeout> | null = null
  githubCacheRetryDelayMs = 0
  /** Fingerprint of a sidecar the loaded cache imported or supersedes; retired once rows commit. */
  githubCacheLegacyFileHash: string | null = null
  /** The saved cache or an older build's sidecar was unreadable at load: save nothing this session. */
  githubCachePersistenceDisabled = false
  readonly githubCacheWriteListeners = new Set<() => void>()
  readonly staleGithubCacheTempCleanup: Promise<void>
  readonly staleProfileStateTempCleanup: Promise<void>
  readonly gitUsernameCache = new Map<string, string>()
  readonly protectedSecrets = new ProtectedSecretPersistence()
  loadNeedsSave = false
  originalExperimentalNativeChat?: { readonly experimentalNativeChat: unknown }
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
  readonly workspaceSessionWriteListeners = new Set<WorkspaceSessionWriteListener>()
  readonly workspaceSessionOperationListeners = new Set<WorkspaceSessionOperationListener>()
  /** In-memory host/leaf binding generations; layout-owner builds only. */
  readonly ptyBindingGenerations = new Map<string, number>()
  /** In-memory editor views by partition; layout-owner builds only. */
  readonly layoutEditorViews = new Map<ExecutionHostId, PartitionEditorViews>()
  readonly stateWriteListeners = new Set<StateWriteListener>()
  readonly worktreeMetaWriteListeners = new Set<WorktreeMetaWriteListener>()
  // This store's workspaceMetadata position: a new epoch per process, one seq per published record.
  readonly workspaceMetadataCursor = { epoch: randomUUID(), seq: 0 }
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
    this.paneShellPath = options.paneShellPath ?? resolveNewPaneShellPath
    this.staleProfileStateTempCleanup = this.profileStateAuthority
      ? removeStaleDurableWriteTempFiles(this.dataFile, {
          minimumAgeMs: STALE_DURABLE_WRITE_TEMP_AGE_MS
        })
      : Promise.resolve()
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
    this.orcadMigrationBlobRoot = join(dirname(this.dataFile), 'orcad-migration-blobs')
    this.orcadTerminalRestoreHints = new OrcadTerminalRestoreHintStore(this.orcadMigrationBlobRoot)
  }
}
