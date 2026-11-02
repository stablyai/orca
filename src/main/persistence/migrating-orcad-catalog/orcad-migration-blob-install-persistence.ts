import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getHistoryRoot } from '../../terminal-history-paths'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { findOrcadMigrationImportReceipt } from './orcad-catalog-receipt-ledger'
import { installOrcadMigrationReceivedBlobs } from './orcad-migration-blob-installers'
import { listOrcadMigrationReceivedBlobNames } from './orcad-migration-blob-staging'
import type { OrcadMigrationRequestIdentity } from './orcad-migration-staged-file'

type OrcadMigrationBlobInstallRuntime = Pick<
  StoreRuntimeState,
  | 'state'
  | 'orcadMigrationBlobRoot'
  | 'orcadTerminalRestoreHints'
  | 'paneShellPath'
  | 'deferredShellHistoryWorktreeIds'
>

type ClockOptions = { now?: () => Date }
type InstallOptions = ClockOptions & {
  /** The runtime's live-shell check; a moved history waits while a shell runs in its worktree. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
}

const orcadMigrationBlobInstallContext = Symbol('OrcadMigrationBlobInstallPersistence')
type OrcadMigrationBlobInstallContext = {
  runtime: OrcadMigrationBlobInstallRuntime
}

/** The destination's committed migration blobs, installed into host-local state and consumed. */
export class OrcadMigrationBlobInstallPersistence {
  readonly [orcadMigrationBlobInstallContext]: OrcadMigrationBlobInstallContext

  constructor(runtime: OrcadMigrationBlobInstallRuntime) {
    this[orcadMigrationBlobInstallContext] = { runtime }
  }

  /**
   * Run only once the commit is durable: installing first and then losing the commit would leave
   * live hints or history for a catalog this host never received. A no-op before commit and on
   * repeats.
   */
  installOrcadMigrationReceivedBlobs(
    manifest: OrcadMigrationManifest,
    options: InstallOptions = {}
  ): void {
    const receipt = findOrcadMigrationImportReceipt(
      this[orcadMigrationBlobInstallContext].runtime.state,
      manifest
    )
    if (receipt?.manifestSha256 !== manifest.manifestSha256) {
      return
    }
    installCommitted(this[orcadMigrationBlobInstallContext].runtime, manifest, options)
  }

  /** Finishes installs a crash or failed write left behind; every receipt on disk is durable. */
  installPendingOrcadMigrationReceivedBlobs(options: InstallOptions = {}): void {
    const { runtime } = this[orcadMigrationBlobInstallContext]
    for (const receipt of [
      ...(runtime.state.orcadMigrationImportReceipts ?? []),
      ...(runtime.state.orcadMigrationEvictedReceipts ?? [])
    ]) {
      try {
        installCommitted(runtime, receipt, options)
      } catch (error) {
        console.error(
          `[orcad-migration] installing received blobs for ${receipt.migrationId} failed:`,
          error
        )
      }
    }
  }

  /** Whether any committed migration still holds a received shell history; only the runtime installs those. */
  hasPendingOrcadMigrationShellHistory(): boolean {
    const { runtime } = this[orcadMigrationBlobInstallContext]
    return [
      ...(runtime.state.orcadMigrationImportReceipts ?? []),
      ...(runtime.state.orcadMigrationEvictedReceipts ?? [])
    ].some((receipt) =>
      listOrcadMigrationReceivedBlobNames(
        runtime.orcadMigrationBlobRoot,
        receipt,
        'shell-history'
      ).some((key) => ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key))
    )
  }

  /** Retries a history install that waited on this worktree's shells; a no-op for any other. */
  installDeferredOrcadMigrationShellHistory(
    worktreeId: string,
    options: InstallOptions = {}
  ): void {
    const { runtime } = this[orcadMigrationBlobInstallContext]
    if (runtime.deferredShellHistoryWorktreeIds.has(worktreeId)) {
      this.installPendingOrcadMigrationReceivedBlobs(options)
    }
  }

  /** The moved pane's last folder while its hint is installed for this worktree; never removes it. */
  peekOrcadMigrationTerminalRestoreHint(
    paneKey: string,
    worktreeId: string,
    options: ClockOptions = {}
  ): string | null {
    return this[orcadMigrationBlobInstallContext].runtime.orcadTerminalRestoreHints.peek(
      paneKey,
      worktreeId,
      clock(options)
    )
  }

  /** Called once the pane spawned: whatever cwd that create used, it was the restore. */
  consumeOrcadMigrationTerminalRestoreHint(paneKey: string, options: ClockOptions = {}): void {
    this[orcadMigrationBlobInstallContext].runtime.orcadTerminalRestoreHints.consume(
      paneKey,
      clock(options)
    )
  }
}

function installCommitted(
  runtime: OrcadMigrationBlobInstallRuntime,
  migration: OrcadMigrationRequestIdentity,
  options: InstallOptions
): void {
  installOrcadMigrationReceivedBlobs({
    migration,
    root: runtime.orcadMigrationBlobRoot,
    terminalRestoreHints: runtime.orcadTerminalRestoreHints,
    shellHistoryRoot: getHistoryRoot(),
    paneShellPath: () => runtime.paneShellPath(runtime.state.settings?.terminalDefaultShell),
    worktreeHasLiveShells: options.worktreeHasLiveShells,
    deferredShellHistoryWorktreeIds: runtime.deferredShellHistoryWorktreeIds,
    paneWorktreeId: (paneKey) => findPaneWorktreeId(runtime.state, paneKey),
    now: clock(options)
  })
}

function clock(options: ClockOptions): number {
  return (options.now ?? (() => new Date()))().getTime()
}

// The commit merged the moved session in with its worktree ids unchanged.
function findPaneWorktreeId(state: PersistedState, paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      if (tabs.some((tab) => tab.id === tabId)) {
        return worktreeId
      }
    }
  }
  return null
}
