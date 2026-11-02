/**
 * What the WSL move driver needs from the rest of the app, as ports, so the whole run is testable
 * with fakes and the production wiring stays in one place (wsl-move-driver-wiring).
 */
import type { WslMoveBrowserCookieFreshPartitionReason } from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { WslMoveProgressEvent } from '../../../shared/wsl-move/wsl-move-driver-types'
import type {
  OrcadMigrationBlobDestination,
  OrcadMigrationBlobSource
} from '../../ssh/orcad-migration-blob-coordinator'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import type { OrcadMigrationSnapshotSource } from '../../ssh/orcad-migration-snapshot-coordinator'
import type { WslMoveHostHolding } from './wsl-move-delta-plan'
import type { WslMoveQuiesceDeps } from './wsl-move-quiesce'
import type { WslMoveSleptScrollback } from './wsl-move-slept-scrollback'
import type { WslMoveRestoreHintPane } from './wsl-move-restore-hints'
import type {
  WslMoveManifestExport,
  WslMoveManifestExportRequest
} from './wsl-move-manifest-export'
import type { WslMoveGateInputs } from './wsl-move-terminal-gate'

export type {
  WslMoveManifestExport,
  WslMoveManifestExportRequest
} from './wsl-move-manifest-export'

/** Throws `WslMoveScopeChangedError` when a planned row is gone: plan again. */
export type WslMoveManifestExporter = (
  request: WslMoveManifestExportRequest
) => WslMoveManifestExport

/** The distro's WSL host, connected. */
export type WslMoveHost = {
  environmentId: string
  name: string
  /** The distro's registry id, which binds the move to this exact distro; absent when unknown. */
  distroGuid?: string
  capabilities: readonly string[]
  /** Read after the connect re-saved the deployment link; absent when no Orca profile is active. */
  browserLoginsNotCarried?: WslMoveBrowserCookieFreshPartitionReason
  catalog: OrcadMigrationDestinationCatalog
  /** Commit naming every blob sent, so the host refuses a commit missing one. */
  commitWithBlobs: (
    manifest: OrcadMigrationManifest,
    expectedBlobs: readonly OrcadMigrationBlobDescriptor[]
  ) => Promise<OrcadMigrationCatalogState>
  blobs: Pick<OrcadMigrationBlobDestination, 'stageChunk'>
  readHolding: () => Promise<WslMoveHostHolding>
}

export type WslMoveCatalogRows = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}

export type WslMoveTerminalScope = {
  workspaceIds: readonly string[]
  workspaceKeys: ReadonlySet<string>
}

export type WslMoveDriverDeps = {
  userDataPath: string
  readCatalog: () => WslMoveCatalogRows
  /** Null when the distro has no connected host. */
  connectHost: (distro: string) => Promise<WslMoveHost | null>
  /**
   * From the distro registrations: false only when the name is gone and so is the recorded GUID
   * (a rename keeps it, and the renamed host may hold the commit); null when unreadable.
   */
  isDistroRegistered: (distro: string, distroGuid?: string) => Promise<boolean | null>
  exportManifest: WslMoveManifestExporter
  /** Busy, working, automation and dispatch facts for the scope, from their owning stores. */
  gateInputs: (scope: WslMoveTerminalScope) => Promise<WslMoveGateInputs>
  /** The panes the scope's live terminals belong to; read before Sleep ends their sessions. */
  listPanes: (scope: WslMoveTerminalScope) => readonly WslMoveRestoreHintPane[]
  /**
   * Panes slept before the move: bindings the saved session or the window still holds, checked
   * against the scope. Their checkpoints give the folder the restore hints carry.
   */
  sleptSessionPanes?: (
    workspaceIds: readonly string[],
    reported: readonly WslMoveRestoreHintPane[]
  ) => readonly WslMoveRestoreHintPane[]
  /** Live bridge panes' shell folders by pane key, read in their distro; absent off Windows. */
  shellCwds?: (panes: readonly WslMoveRestoreHintPane[]) => Promise<ReadonlyMap<string, string>>
  quiesce: Pick<
    WslMoveQuiesceDeps,
    'sleepWorkspaces' | 'livePtyIds' | 'captureRestoreHints' | 'proveExited' | 'wait'
  >
  snapshots: OrcadMigrationSnapshotSource
  /**
   * After Sleep, each paused pane's daemon checkpoint as the buffer a terminal restores from. A
   * slept pane has no renderer snapshot, so this is its only scrollback.
   */
  sleptScrollback?: (
    panes: readonly WslMoveRestoreHintPane[],
    distro: string,
    migrationId: string,
    /** The scope's workspaces, for panes slept before the move (no live terminal to list). */
    workspaceIds: readonly string[],
    /** The window's bindings of slept panes, which main no longer holds; checked before use. */
    reported: readonly WslMoveRestoreHintPane[]
  ) => Promise<WslMoveSleptScrollback>
  shellHistory: (
    distro: string,
    worktrees: WslMoveManifestExport['worktrees']
  ) => Promise<{ descriptors: OrcadMigrationBlobDescriptor[]; source: OrcadMigrationBlobSource }>
  /** After commit: rewrite this desktop's main-process stores; the renderer then reloads. */
  finishOnDesktop: () => Promise<void>
  progress: (event: WslMoveProgressEvent) => void
  newMigrationId: () => string
  now: () => Date
}
