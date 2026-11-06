import { existsSync } from 'node:fs'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { recoverInterruptedGuardedFileOperation } from './fs-utils'
import type { CodexSharedRuntimeAuthProvenanceStatus } from './runtime-home-service-types'
import { codexAuthIsMonotonicallyFresher } from './runtime-home-service-auth-sync-identity'
import { CodexRuntimeHomeWsl } from './runtime-home-service-wsl'

export abstract class CodexRuntimeHomeSync extends CodexRuntimeHomeWsl {
  syncForCurrentSelection(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv
  ): void {
    if (target?.runtime === 'wsl') {
      this.startLegacyWslAuthDrain(this.resolveWslDefaultTarget(target))
      return
    }

    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      // Per-account auth must bypass the shared mirror's snapshot and read-back machinery.
      this.syncSelfContainedManagedSelection(selfContainedAccount)
      return
    }
    const settings = this.store.getSettings()
    if (this.lastHostAccountUsedSelfContainedHome) {
      // Discard the legacy baseline without adopting stale mirror bytes from a self-contained account.
      this.lastHostAccountUsedSelfContainedHome = false
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      if (this.isHostSystemDefaultRealHomeSelected(launchEnv)) {
        return
      }
    }
    if (this.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      // Defer retained-pane auth reconciliation until durable provenance can establish ownership.
      if (this.lastSyncedAccountId !== null) {
        this.sharedAuthRefreshBlockedByManagedTransition = true
        this.lastSyncedAccountId = null
        this.lastWrittenAuthJson = null
      }
      return
    }
    const runtimeAuthExistedBeforeSync = existsSync(this.getRuntimeAuthPath())
    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: false })
    }
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    if (activeAccount) {
      // Remaining accounts are WSL-local, so host synchronization only drops its baseline.
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      return
    }
    if (normalizeCodexRuntimeSelection(settings).host) {
      this.store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...normalizeCodexRuntimeSelection(settings),
          host: null
        }
      })
    }
    // Restore snapshots only when leaving managed selection; later syncs follow current system auth.
    if (this.lastSyncedAccountId !== null) {
      this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
      this.lastSyncedAccountId = null
    } else if (!runtimeAuthExistedBeforeSync) {
      const logoutMarkerStatus = this.getRuntimeLogoutMarkerStatus()
      if (logoutMarkerStatus.kind === 'applies') {
        this.lastWrittenAuthJson = null
      } else if (
        logoutMarkerStatus.kind === 'system-default-changed' &&
        logoutMarkerStatus.systemDefaultAuthJson !== null
      ) {
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: false })
      } else if (logoutMarkerStatus.kind === 'system-default-changed') {
        // Preserve a later system logout instead of restoring stale snapshot credentials.
        this.captureSystemDefaultSnapshot({ force: true })
        this.persistRuntimeLogoutMarker(null)
        this.lastWrittenAuthJson = null
      } else if (this.lastWrittenAuthJson === null) {
        // Seed the runtime home once from system auth without changing ~/.codex.
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: false })
      } else {
        this.persistRuntimeLogoutMarker()
      }
    } else {
      this.clearRuntimeLogoutMarker()
      this.syncRuntimeAuthWithSystemDefault()
    }
  }

  // Fresh credentials from add or reauth invalidate the shared-mirror baseline.
  clearLastWrittenAuthJson(
    accountId = normalizeCodexRuntimeSelection(this.store.getSettings()).host
  ): void {
    if (accountId === normalizeCodexRuntimeSelection(this.store.getSettings()).host) {
      this.lastWrittenAuthJson = null
    }
  }

  protected resolveSystemDefaultMirrorClaim(
    runtimeAuth: string,
    provenanceStatus: CodexSharedRuntimeAuthProvenanceStatus
  ): { ownershipProven: boolean; mirroredAuthJson: string | null } {
    const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
    const snapshotAuth =
      this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())?.authJson ?? null
    const preProvenanceRuntimeRefreshProven =
      provenanceStatus.kind === 'missing' &&
      snapshotAuth !== null &&
      this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, snapshotAuth) &&
      codexAuthIsMonotonicallyFresher(runtimeAuth, snapshotAuth)
    return {
      ownershipProven: provenance?.owner === 'system-default' || preProvenanceRuntimeRefreshProven,
      mirroredAuthJson:
        provenance?.owner === 'system-default'
          ? provenance.authJson
          : provenanceStatus.kind === 'missing'
            ? (this.lastWrittenAuthJson ?? snapshotAuth)
            : null
    }
  }

  protected safeSyncForCurrentSelection(): void {
    try {
      this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync runtime auth state:', error)
    }
  }

  protected safeRecoverInterruptedRuntimeAuthOperation(): void {
    try {
      recoverInterruptedGuardedFileOperation(this.getRuntimeAuthPath())
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to recover interrupted auth update:', error)
    }
  }
}
