import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import {
  writeFileAtomically,
  writeFileAtomicallyIfUnchanged
} from '../../../filesystem/atomic-file-publication'
import { CodexRuntimeHomeLaunch } from '../routing/runtime-home-service-launch'
import type { CodexSystemDefaultSnapshot } from '../runtime-home-service-types'

export abstract class CodexRuntimeHomeSystemDefaultSnapshot extends CodexRuntimeHomeLaunch {
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
      // A missing runtime credential records a local logout and must not revive snapshot auth.
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }

    if (options.detectExternalLogin) {
      // Preserve system logout when switching back from a managed account.
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

  protected writeSystemDefaultAuth(
    contents: string,
    options?: { expectedContents: string | null }
  ): boolean {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    mkdirSync(dirname(systemDefaultAuthPath), { recursive: true })
    if (!options) {
      writeFileAtomically(systemDefaultAuthPath, contents, { mode: 0o600 })
    } else if (
      !writeFileAtomicallyIfUnchanged(systemDefaultAuthPath, options.expectedContents, contents, {
        mode: 0o600,
        credential: true
      })
    ) {
      return false
    }
    this.ensureOwnerOnlyMode(systemDefaultAuthPath)
    return true
  }

  protected clearRuntimeAuthAfterSystemDefaultLogout(path: string, snapshot = true): void {
    rmSync(path, { force: true })
    if (snapshot) {
      this.captureSystemDefaultSnapshot({ force: true })
    }
    this.persistRuntimeLogoutMarker()
    this.lastWrittenAuthJson = null
    this.persistSharedRuntimeAuthProvenance({
      owner: 'system-default',
      authJson: null
    })
  }
}
