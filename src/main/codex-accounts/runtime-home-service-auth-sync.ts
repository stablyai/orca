import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { removeFileAtomicallyIfUnchanged, writeFileAtomically } from './fs-utils'
import { CodexRuntimeHomeLaunch } from './runtime-home-service-launch'
import type { CodexSystemDefaultSnapshot } from './runtime-home-service-types'

export abstract class CodexRuntimeHomeAuthSync extends CodexRuntimeHomeLaunch {
  protected captureSystemDefaultSnapshot(options: { force: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const runtimeAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    const snapshot: CodexSystemDefaultSnapshot = {
      authJson: existsSync(runtimeAuthPath) ? readFileSync(runtimeAuthPath, 'utf-8') : null
    }
    writeFileAtomically(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  }

  protected syncRuntimeAuthWithSystemDefault(): void {
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    if (!existsSync(runtimeAuthPath)) {
      return
    }

    try {
      const runtimeAuth = readFileSync(runtimeAuthPath, 'utf-8')
      const provenanceStatus = this.resolveSharedRuntimeAuthProvenanceStatus()
      const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
      if (provenance?.owner === 'managed') {
        this.captureSystemDefaultSnapshot({ force: true })
        if (!existsSync(systemDefaultAuthPath)) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
          return
        }
        this.writeRuntimeAuth(readFileSync(systemDefaultAuthPath, 'utf-8'), {
          owner: 'system-default'
        })
        return
      }
      const {
        ownershipProven: systemDefaultOwnershipProven,
        mirroredAuthJson: mirroredSystemDefaultAuth
      } = this.resolveSystemDefaultMirrorClaim(runtimeAuth, provenanceStatus)
      if (!existsSync(systemDefaultAuthPath)) {
        if (mirroredSystemDefaultAuth !== null && runtimeAuth === mirroredSystemDefaultAuth) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
          return
        }
        if (
          systemDefaultOwnershipProven &&
          mirroredSystemDefaultAuth !== null &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
        ) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
        }
        return
      }
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      if (runtimeAuth === systemDefaultAuth) {
        this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
        return
      }
      if (
        systemDefaultOwnershipProven &&
        mirroredSystemDefaultAuth !== null &&
        systemDefaultAuth === mirroredSystemDefaultAuth &&
        this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
      ) {
        // Why: Codex refreshes tokens in the runtime CODEX_HOME; read that back to ~/.codex so the next sync won't clobber fresh creds with stale ones.
        this.writeSystemDefaultAuth(runtimeAuth)
        this.captureSystemDefaultSnapshot({ force: true })
        this.writeRuntimeAuth(runtimeAuth, { owner: 'system-default' })
        return
      }
      // Why: mirror external logins/logouts into Orca's runtime home so unmanaged Codex sessions keep matching the current system-default state.
      this.captureSystemDefaultSnapshot({ force: true })
      this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync system-default auth:', error)
    }
  }

  protected syncLegacySharedSystemDefaultAuthForRetainedPanes(): void {
    if (this.sharedAuthRefreshBlockedByManagedTransition || this.lastSyncedAccountId !== null) {
      this.sharedAuthRefreshBlockedByManagedTransition = false
      return
    }
    const runtimeAuthPath = this.getRuntimeAuthPath()
    try {
      let provenanceStatus = this.resolveSharedRuntimeAuthProvenanceStatus()
      if (
        provenanceStatus.kind === 'committed' &&
        provenanceStatus.provenance.owner === 'managed'
      ) {
        const restoredProvenance = this.restoreUntouchedSystemDefaultProvenance(
          provenanceStatus.provenance
        )
        if (restoredProvenance) {
          provenanceStatus = { kind: 'committed', provenance: restoredProvenance }
        }
      }
      if (
        provenanceStatus.kind === 'fenced' ||
        (provenanceStatus.kind === 'committed' && provenanceStatus.provenance.owner === 'managed')
      ) {
        return
      }
      const systemAuth = this.readSystemDefaultAuth()
      if (!existsSync(runtimeAuthPath)) {
        const logoutMarkerStatus = this.getRuntimeLogoutMarkerStatus()
        const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
        const knownSystemAuthBaseline =
          provenanceStatus.kind === 'committed' &&
          provenanceStatus.provenance.owner === 'system-default'
            ? provenanceStatus.provenance.authJson
            : provenanceStatus.kind === 'missing'
              ? (this.lastWrittenAuthJson ?? snapshot?.authJson)
              : undefined
        if (systemAuth === null) {
          if (
            provenanceStatus.kind === 'committed' &&
            provenanceStatus.provenance.owner === 'system-default' &&
            provenanceStatus.provenance.authJson === null &&
            logoutMarkerStatus.kind === 'applies' &&
            snapshot?.authJson === null
          ) {
            this.lastWrittenAuthJson = null
            return
          }
          // Why: commit a crashed logout before a managed transition can discard its recovery baseline.
          this.captureSystemDefaultSnapshot({ force: true })
          this.persistRuntimeLogoutMarker(null)
          this.lastWrittenAuthJson = null
          this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
          return
        }
        if (
          logoutMarkerStatus.kind === 'system-default-changed' ||
          (knownSystemAuthBaseline !== undefined && knownSystemAuthBaseline !== systemAuth)
        ) {
          const replaced = this.writeRuntimeAuth(
            systemAuth,
            {
              owner: 'system-default'
            },
            { expectedContents: null }
          )
          if (replaced) {
            this.captureSystemDefaultSnapshot({ force: true })
          }
        }
        return
      }
      const runtimeAuthBeforeSync = readFileSync(runtimeAuthPath, 'utf-8')
      const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
      const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
      const knownSharedAuth =
        provenance?.owner === 'system-default'
          ? provenance.authJson
          : provenanceStatus.kind === 'missing'
            ? (this.lastWrittenAuthJson ?? snapshot?.authJson ?? null)
            : null
      // Why: only bytes Orca can prove it wrote belong to the compatibility
      // mirror; retained Codex or a managed transition owns every other value.
      if (knownSharedAuth === null) {
        return
      }
      const sharedAuthOwnedBySystemDefault =
        runtimeAuthBeforeSync === knownSharedAuth ||
        (provenance?.owner === 'system-default' &&
          systemAuth === null &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuthBeforeSync, knownSharedAuth))
      if (!sharedAuthOwnedBySystemDefault) {
        return
      }
      if (systemAuth === null) {
        removeFileAtomicallyIfUnchanged(runtimeAuthPath, runtimeAuthBeforeSync)
        if (existsSync(runtimeAuthPath)) {
          this.persistSharedRuntimeAuthProvenance({ owner: 'fenced' })
          return
        }
        this.captureSystemDefaultSnapshot({ force: true })
        this.persistRuntimeLogoutMarker(null)
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({
          owner: 'system-default',
          authJson: null
        })
        return
      }
      if (runtimeAuthBeforeSync !== knownSharedAuth) {
        return
      }
      const replaced = this.writeRuntimeAuth(
        systemAuth,
        { owner: 'system-default' },
        { expectedContents: runtimeAuthBeforeSync }
      )
      if (replaced) {
        this.captureSystemDefaultSnapshot({ force: true })
      }
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to refresh retained-pane auth:', error)
    }
  }

  protected restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    if (existsSync(systemDefaultAuthPath)) {
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      this.captureSystemDefaultSnapshot({ force: true })
      this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
      return
    }

    if (options.detectExternalLogin && !existsSync(runtimeAuthPath)) {
      // Why: with Orca owning CODEX_HOME, a deleted runtime auth.json is a local logout, not a cue to restore the user's real ~/.codex snapshot.
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }

    if (options.detectExternalLogin) {
      // Why: if ~/.codex/auth.json vanished while a managed account was selected, switching back must preserve that external system-default logout.
      rmSync(runtimeAuthPath, { force: true })
      this.captureSystemDefaultSnapshot({ force: true })
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }

    if (!existsSync(snapshotPath)) {
      this.captureSystemDefaultSnapshot({ force: true })
    }

    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (!snapshot) {
      console.warn('[codex-runtime-home] Ignoring invalid system-default auth snapshot')
      rmSync(snapshotPath, { force: true })
      this.captureSystemDefaultSnapshot({ force: true })
      const refreshedSnapshot = this.readSystemDefaultSnapshot(snapshotPath)
      if (!refreshedSnapshot) {
        rmSync(runtimeAuthPath, { force: true })
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
        return
      }
      if (refreshedSnapshot.authJson === null) {
        rmSync(runtimeAuthPath, { force: true })
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
        return
      }
      this.writeRuntimeAuth(refreshedSnapshot.authJson, { owner: 'system-default' })
      return
    }
    if (snapshot.authJson === null) {
      rmSync(runtimeAuthPath, { force: true })
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }
    this.writeRuntimeAuth(snapshot.authJson, { owner: 'system-default' })
  }

  protected writeSystemDefaultAuth(contents: string): void {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    mkdirSync(dirname(systemDefaultAuthPath), { recursive: true })
    writeFileAtomically(systemDefaultAuthPath, contents, { mode: 0o600 })
    this.ensureOwnerOnlyMode(systemDefaultAuthPath)
  }

  protected clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath: string): void {
    // Why: a vanished ~/.codex auth means external logout for unmanaged sessions, even if runtime auth already refreshed in Orca's CODEX_HOME.
    rmSync(runtimeAuthPath, { force: true })
    this.captureSystemDefaultSnapshot({ force: true })
    this.persistRuntimeLogoutMarker()
    this.lastWrittenAuthJson = null
    this.persistSharedRuntimeAuthProvenance({
      owner: 'system-default',
      authJson: null
    })
  }
}
