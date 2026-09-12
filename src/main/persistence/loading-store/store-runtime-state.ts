import { removeStaleDurableWriteTempFiles } from '../../durable-file-write'
import { dirname } from 'node:path'
import { PtyOwnershipTransferSnapshotHistory } from './pty-ownership-transfer-snapshot-history'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ActiveViewPreference } from '../../active-view-preference'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { OrcadLiveCompletionDurability } from './orcad-live-completion-durability'
import { OrcadRetirementSessionPublication } from './orcad-retirement-session-publication'
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

export type StoreRuntimeOptions = {
  dataFile?: string
  storageAuthority?: AutomationStorageAuthority
}

/** Mutable coordination state shared only with this Store's private collaborators. */
export class StoreRuntimeState {
  state!: PersistedState
  readonly dataFile: string
  readonly transferSnapshotHistory: PtyOwnershipTransferSnapshotHistory
  readonly storageAuthority: AutomationStorageAuthority
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
  quitFlushStarted = false
  quitFlushPromise: Promise<void> | null = null
  lastWrittenStateHash: string | null = null
  lastDurableWriteGeneration = -1
  readonly orcadLiveCompletionDurability = new OrcadLiveCompletionDurability()
  readonly orcadRetirementSessionPublication: OrcadRetirementSessionPublication
  firstPendingSaveAt: number | null = null
  githubCacheDirty = false
  githubCacheGeneration = 0
  pendingGithubCacheWrite: Promise<void> | null = null
  readonly staleGithubCacheTempCleanup: Promise<void>
  readonly gitUsernameCache = new Map<string, string>()
  readonly protectedSecrets = new ProtectedSecretPersistence()
  loadNeedsSave = false
  flushOrThrow!: () => void
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
    this.orcadRetirementSessionPublication = new OrcadRetirementSessionPublication(
      dirname(this.dataFile)
    )
    this.transferSnapshotHistory = new PtyOwnershipTransferSnapshotHistory(dirname(this.dataFile))
    this.storageAuthority = options.storageAuthority ?? 'desktop'
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
