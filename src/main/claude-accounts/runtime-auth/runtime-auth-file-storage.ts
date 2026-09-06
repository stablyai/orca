import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import { ClaudeRuntimeAuthState } from './runtime-auth-state'

export class ClaudeRuntimeAuthFileStorage extends ClaudeRuntimeAuthState {
  protected writeRuntimeCredentials(contents: string): void {
    const credentialsPath = this.pathResolver.getRuntimePaths().credentialsPath
    mkdirSync(dirname(credentialsPath), { recursive: true })
    // Why: skip unchanged rewrites to dodge Windows EPERM contention (#1507); re-verify the file since another Claude may have rewritten it.
    if (
      this.lastWrittenCredentialsJson === contents &&
      this.fileContentsEqual(credentialsPath, contents)
    ) {
      this.ensureOwnerOnlyMode(credentialsPath)
      return
    }
    if (this.fileContentsEqual(credentialsPath, contents)) {
      this.ensureOwnerOnlyMode(credentialsPath)
      this.lastWrittenCredentialsJson = contents
      return
    }
    writeFileAtomically(credentialsPath, contents, { mode: 0o600 })
    this.lastWrittenCredentialsJson = contents
  }

  protected writeJson(targetPath: string, value: unknown): void {
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    mkdirSync(dirname(targetPath), { recursive: true })
    // Why: same Windows contention reason as writeRuntimeCredentials.
    if (this.fileContentsEqual(targetPath, serialized)) {
      return
    }
    writeFileAtomically(targetPath, serialized, { mode: 0o600 })
  }

  protected fileContentsEqual(targetPath: string, contents: string): boolean {
    try {
      return existsSync(targetPath) && readFileSync(targetPath, 'utf-8') === contents
    } catch {
      return false
    }
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

  protected readJsonObject(targetPath: string): Record<string, unknown> | null {
    if (!existsSync(targetPath)) {
      return {}
    }
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Why: invalid config is unknown external state; return null so we don't erase user or Claude-owned settings.
      return null
    }
    return null
  }

  protected getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'claude-runtime-auth')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  protected getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }
}
