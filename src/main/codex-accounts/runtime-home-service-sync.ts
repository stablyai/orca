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
      // Why: self-contained managed homes hold their own auth, so the shared
      // runtime home's snapshot/hot-swap/read-back machinery below must not run.
      this.syncSelfContainedManagedSelection(selfContainedAccount)
      return
    }
    const settings = this.store.getSettings()
    if (this.lastHostAccountUsedSelfContainedHome) {
      // Why: the account's auth is already canonical in its own home. Reset the
      // legacy mirror baseline without reading it; a real-home deselect needs no
      // further sync, and the mirror lane below re-seeds from canonical storage.
      this.lastHostAccountUsedSelfContainedHome = false
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      if (this.isHostSystemDefaultRealHome(launchEnv)) {
        return
      }
    }
    if (this.isHostSystemDefaultRealHome(launchEnv)) {
      // Why: retained daemon panes may own shared auth from a managed launch;
      // compatibility reconciliation runs later with durable provenance.
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
      // Why: only a WSL-managed account can reach here — every host account was
      // routed to its own self-contained home above. Its auth lives in the
      // distro-local runtime home, so the host mirror only drops its baseline.
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
    // Why: only restore the system-default mirror when leaving a managed account; otherwise later syncs mirror current ~/.codex instead of replaying an old snapshot.
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
        // Why: a real ~/.codex logout after a local runtime logout should keep runtime auth absent, not restore the stale snapshot.
        this.captureSystemDefaultSnapshot({ force: true })
        this.persistRuntimeLogoutMarker(null)
        this.lastWrittenAuthJson = null
      } else if (this.lastWrittenAuthJson === null) {
        // Why: unmanaged sessions use an Orca-owned CODEX_HOME; seed it once from system-default auth so terminals stay logged in without mutating ~/.codex.
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: false })
      } else {
        this.persistRuntimeLogoutMarker()
      }
    } else {
      this.clearRuntimeLogoutMarker()
      this.syncRuntimeAuthWithSystemDefault()
    }
  }

  // Why: re-auth/add-account writes fresh host tokens, invalidating the shared mirror baseline.
  clearLastWrittenAuthJson(
    accountId = normalizeCodexRuntimeSelection(this.store.getSettings()).host
  ): void {
    if (accountId === normalizeCodexRuntimeSelection(this.store.getSettings()).host) {
      this.lastWrittenAuthJson = null
    }
  }

  // Why: which ~/.codex bytes the mirror was seeded from, and whether the system
  // default can be proven to own the mirror at all.
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
