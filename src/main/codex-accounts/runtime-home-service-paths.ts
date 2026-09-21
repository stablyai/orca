import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { app } from 'electron'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getOrcaManagedCodexHomePath, getOrcaUserDataPath } from '../codex/codex-home-paths'
import type { CodexMirroredHomeStatus } from './runtime-home-service-types'
import { CodexRuntimeHomeState } from './runtime-home-service-state'

export abstract class CodexRuntimeHomePaths extends CodexRuntimeHomeState {
  protected getRuntimeHomePath(): string {
    return getOrcaManagedCodexHomePath()
  }

  /**
   * Resolves the managed home the config mirror actually targets for the
   * current HOST selection, or null when no mirror runs for it.
   *
   * Read-only on purpose: unlike the launch and quota-fetch paths this prepares
   * nothing and creates no directories, so surfacing sync health cannot alter
   * the state it is reporting on. Returns null for the system default on the
   * real-home lane, which runs Codex directly against ~/.codex — there is no
   * mirror there, so there is nothing that can fall behind.
   */
  getMirroredHostHomePathForStatus(): CodexMirroredHomeStatus {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'indeterminate') {
        // Why: `null` here is a positive claim that no mirror exists, which the
        // status channel reports as healthy. An unreadable home is not that.
        return { kind: 'unavailable' }
      }
      return { kind: 'ready', homePath: resolved.kind === 'owned' ? resolved.homePath : null }
    }
    if (this.isHostSystemDefaultRealHome()) {
      return { kind: 'ready', homePath: null }
    }
    return {
      kind: 'ready',
      homePath: join(getOrcaUserDataPath(), 'codex-runtime-home', 'home')
    }
  }

  protected getRuntimeAuthPath(): string {
    return join(this.getRuntimeHomePath(), 'auth.json')
  }

  protected getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }

  protected getRuntimeLogoutMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-runtime-logout.json')
  }

  protected getSharedRuntimeAuthProvenancePath(): string {
    return join(this.getRuntimeMetadataDir(), 'shared-runtime-auth-provenance.json')
  }

  protected getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'codex-runtime-home')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  protected getLegacyHostActiveHomePath(): string {
    return join(this.getRuntimeMetadataDir(), 'active', 'host', 'home')
  }

  protected getMigrationMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-v1.json')
  }

  protected getMigrationDiagnosticsPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-diagnostics.jsonl')
  }

  protected getManagedAccountsRoot(): string {
    return join(app.getPath('userData'), 'codex-accounts')
  }

  protected repointLegacyActiveHomePointer(activeHomePath: string, runtimeHomePath: string): void {
    if (this.activeHomeAlreadyPointsToRuntimeHome(activeHomePath, runtimeHomePath)) {
      return
    }
    if (!this.legacyActiveHomeLinkIsReplaceable(activeHomePath)) {
      return
    }

    mkdirSync(runtimeHomePath, { recursive: true })
    mkdirSync(dirname(activeHomePath), { recursive: true })
    const nextLinkPath = `${activeHomePath}.next-${process.pid}-${Date.now()}`
    this.removeLegacyActiveHomeLinkIfOwned(nextLinkPath)
    try {
      symlinkSync(
        runtimeHomePath,
        nextLinkPath,
        process.platform === 'win32' && lstatSync(runtimeHomePath).isDirectory()
          ? 'junction'
          : undefined
      )
      try {
        renameSync(nextLinkPath, activeHomePath)
      } catch (error) {
        if (!this.legacyActiveHomeLinkIsReplaceable(activeHomePath)) {
          throw error
        }
        this.removeLegacyActiveHomeLinkIfOwned(activeHomePath)
        renameSync(nextLinkPath, activeHomePath)
      }
    } finally {
      this.removeLegacyActiveHomeLinkIfOwned(nextLinkPath)
    }
  }

  protected activeHomeAlreadyPointsToRuntimeHome(
    activeHomePath: string,
    runtimeHomePath: string
  ): boolean {
    try {
      return this.linkTargetsMatch(readlinkSync(activeHomePath), activeHomePath, runtimeHomePath)
    } catch {
      return false
    }
  }

  protected linkTargetsMatch(
    linkTarget: string,
    linkPath: string,
    expectedTargetPath: string
  ): boolean {
    const resolvedLinkTarget = isAbsolute(linkTarget)
      ? resolve(linkTarget)
      : resolve(dirname(linkPath), linkTarget)
    return resolvedLinkTarget === resolve(expectedTargetPath)
  }

  protected legacyActiveHomeLinkIsReplaceable(activeHomePath: string): boolean {
    try {
      const stat = lstatSync(activeHomePath)
      return stat.isSymbolicLink() || this.isWindowsReadableLink(activeHomePath)
    } catch {
      return true
    }
  }

  protected legacyActiveHomePathExists(activeHomePath: string): boolean {
    try {
      lstatSync(activeHomePath)
      return true
    } catch {
      return false
    }
  }

  protected removeLegacyActiveHomeLinkIfOwned(activeHomePath: string): void {
    try {
      const stat = lstatSync(activeHomePath)
      if (stat.isSymbolicLink()) {
        unlinkSync(activeHomePath)
      } else if (this.isWindowsReadableLink(activeHomePath)) {
        rmdirSync(activeHomePath)
      }
    } catch {
      // Missing or inaccessible temporary links are handled by the caller.
    }
  }

  protected isWindowsReadableLink(targetPath: string): boolean {
    if (process.platform !== 'win32') {
      return false
    }
    try {
      readlinkSync(targetPath)
      return true
    } catch {
      return false
    }
  }
}
