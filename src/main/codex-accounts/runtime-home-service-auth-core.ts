import { existsSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from './fs-utils'
import type {
  CodexRuntimeLogoutMarker,
  CodexRuntimeLogoutMarkerStatus,
  CodexSharedRuntimeAuthProvenance
} from './runtime-home-service-types'
import { CodexRuntimeHomeLegacyMigration } from './runtime-home-service-legacy-migration'

export abstract class CodexRuntimeHomeAuthCore extends CodexRuntimeHomeLegacyMigration {
  protected readSystemDefaultAuth(): string | null {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    return existsSync(systemDefaultAuthPath) ? readFileSync(systemDefaultAuthPath, 'utf-8') : null
  }

  protected writeRuntimeAuth(
    contents: string,
    owner: { owner: 'system-default' } | { owner: 'managed'; accountId: string },
    options?: { expectedContents: string | null }
  ): boolean {
    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (options && !this.fileContentsMatchExpected(runtimeAuthPath, options.expectedContents)) {
      return false
    }
    const provenance: CodexSharedRuntimeAuthProvenance =
      owner.owner === 'system-default' ? { owner: 'system-default', authJson: contents } : owner
    const runtimeAuthComparison = this.compareFileContents(runtimeAuthPath, contents)
    if (runtimeAuthComparison === null) {
      // An unreadable file may hold newly rotated tokens; refuse rather than overwrite them.
      return false
    }
    const runtimeAuthAlreadyMatches = runtimeAuthComparison
    if (
      runtimeAuthAlreadyMatches &&
      this.sharedRuntimeAuthProvenanceMatches(
        this.resolveSharedRuntimeAuthProvenanceStatus(),
        provenance
      )
    ) {
      this.ensureOwnerOnlyMode(runtimeAuthPath)
      this.lastWrittenAuthJson = contents
      this.clearRuntimeLogoutMarker()
      return true
    }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: provenance,
      runtimeAuthJson: contents
    })
    if (runtimeAuthAlreadyMatches) {
      this.ensureOwnerOnlyMode(runtimeAuthPath)
      this.lastWrittenAuthJson = contents
      this.persistSharedRuntimeAuthProvenance(provenance)
      this.clearRuntimeLogoutMarker()
      return true
    }
    const replaced = options
      ? writeFileAtomicallyIfUnchanged(runtimeAuthPath, options.expectedContents, contents, {
          mode: 0o600
        })
      : (writeFileAtomically(runtimeAuthPath, contents, { mode: 0o600 }), true)
    if (!replaced) {
      return false
    }
    this.lastWrittenAuthJson = contents
    this.persistSharedRuntimeAuthProvenance(provenance)
    this.clearRuntimeLogoutMarker()
    return true
  }

  /** Missing files compare false; null means an inconclusive read that cannot authorize a write. */
  protected compareFileContents(targetPath: string, contents: string): boolean | null {
    try {
      return readFileSync(targetPath, 'utf-8') === contents
    } catch (error) {
      return isDefinitiveAbsence(error) ? false : null
    }
  }

  protected fileContentsEqual(targetPath: string, contents: string): boolean {
    return this.compareFileContents(targetPath, contents) === true
  }

  protected fileContentsMatchExpected(
    targetPath: string,
    expectedContents: string | null
  ): boolean {
    if (expectedContents === null) {
      // This precheck can misread locks as absence; atomic publication still refuses to overwrite.
      return !existsSync(targetPath)
    }
    return this.fileContentsEqual(targetPath, expectedContents)
  }

  protected ensureOwnerOnlyMode(targetPath: string): void {
    if (process.platform === 'win32') {
      return
    }
    try {
      chmodSync(targetPath, 0o600)
    } catch {
      /* Best effort: the next atomic write will set the restrictive mode. */
    }
  }

  protected getRuntimeLogoutMarkerStatus(): CodexRuntimeLogoutMarkerStatus {
    const marker = this.readRuntimeLogoutMarker()
    if (!marker) {
      return { kind: 'missing' }
    }
    const systemDefaultAuthJson = this.readSystemDefaultAuth()
    if (systemDefaultAuthJson === marker.systemDefaultAuthJson) {
      return { kind: 'applies' }
    }
    this.clearRuntimeLogoutMarker()
    return { kind: 'system-default-changed', systemDefaultAuthJson }
  }

  protected persistRuntimeLogoutMarker(systemDefaultAuthJson = this.readSystemDefaultAuth()): void {
    const marker: CodexRuntimeLogoutMarker = {
      systemDefaultAuthJson,
      loggedOutAt: Date.now()
    }
    writeFileAtomically(this.getRuntimeLogoutMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600
    })
  }

  protected readRuntimeLogoutMarker(): CodexRuntimeLogoutMarker | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.getRuntimeLogoutMarkerPath(), 'utf-8')) as unknown
    } catch {
      return null
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('systemDefaultAuthJson' in parsed) ||
      !('loggedOutAt' in parsed)
    ) {
      return null
    }
    const marker = parsed as { systemDefaultAuthJson: unknown; loggedOutAt: unknown }
    if (
      (marker.systemDefaultAuthJson !== null && typeof marker.systemDefaultAuthJson !== 'string') ||
      typeof marker.loggedOutAt !== 'number'
    ) {
      return null
    }
    return marker as CodexRuntimeLogoutMarker
  }

  protected clearRuntimeLogoutMarker(): void {
    rmSync(this.getRuntimeLogoutMarkerPath(), { force: true })
  }
}
