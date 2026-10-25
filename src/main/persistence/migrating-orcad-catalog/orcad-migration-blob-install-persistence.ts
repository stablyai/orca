import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getHistoryRoot } from '../../terminal-history-paths'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  findOrcadMigrationImportReceipt,
  isOrcadMigrationCommitDurable
} from './orcad-catalog-receipt-ledger'
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
  | 'writeGeneration'
  | 'lastDurableWriteGeneration'
  | 'orcadMigrationCommitWriteGenerations'
>

type ClockOptions = { now?: () => Date }
type InstallOptions = ClockOptions & {
  /** Defer history installation while shells run in its worktree. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
}

const orcadMigrationBlobInstallContext = Symbol('OrcadMigrationBlobInstallPersistence')
type OrcadMigrationBlobInstallContext = {
  runtime: OrcadMigrationBlobInstallRuntime
}

export class OrcadMigrationBlobInstallPersistence {
  readonly [orcadMigrationBlobInstallContext]: OrcadMigrationBlobInstallContext

  constructor(runtime: OrcadMigrationBlobInstallRuntime) {
    this[orcadMigrationBlobInstallContext] = { runtime }
  }

  /** Wait for durable commit or a restart could lose both the catalog and its consumed blobs. */
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

  /** Recover interrupted installs; disk-loaded receipts already prove durability. */
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

  /** Only the runtime installs pending shell history. */
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

  installDeferredOrcadMigrationShellHistory(
    worktreeId: string,
    options: InstallOptions = {}
  ): void {
    const { runtime } = this[orcadMigrationBlobInstallContext]
    if (runtime.deferredShellHistoryWorktreeIds.has(worktreeId)) {
      this.installPendingOrcadMigrationReceivedBlobs(options)
    }
  }

  /** Read without consuming. */
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

  /** Consume after spawn, even if it used a different cwd. */
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
  if (!isOrcadMigrationCommitDurable(runtime, migration)) {
    return
  }
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
