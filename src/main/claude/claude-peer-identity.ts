import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { ClaudePeerIdentity } from '../../shared/terminal-process-inspection'
import { listClaudeProfileHomesAsync } from '../claude-accounts/claude-profile-homes'

const REFRESH_MS = 2_000
const MAX_SESSION_BYTES = 64 * 1024

/** Session-file strings reach the UI and JSON output, so reject empty, oversized, or control-char values. */
function displayString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/\p{Cc}/u.test(value)
  )
}

/** Reads a Claude process's name and permission mode from its PID session file, cached briefly per PID. */
export class ClaudePeerIdentityReader {
  private cached?: { pid: number; at: number; value: ClaudePeerIdentity | undefined }
  private pending?: { pid: number; value: Promise<ClaudePeerIdentity | undefined> }

  private readonly configDir: string

  constructor(
    configDir?: string,
    private readonly dataRoot = process.env.ORCA_USER_DATA_PATH
  ) {
    this.configDir =
      configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  }

  /** Resolves undefined for non-Claude processes or when no valid session file exists. */
  read(
    processName: string | null,
    pid: number | null | undefined
  ): Promise<ClaudePeerIdentity | undefined> {
    if (
      recognizeAgentProcess(processName)?.agent !== 'claude' ||
      !pid ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      return Promise.resolve(undefined)
    }
    // Cache misses too: older Claude versions may never publish a session file.
    if (this.cached?.pid === pid && Date.now() - this.cached.at < REFRESH_MS) {
      return Promise.resolve(this.cached.value)
    }
    if (this.pending?.pid === pid) {
      return this.pending.value
    }
    const value = this.readSession(pid)
      .then((identity) => {
        this.cached = { pid, at: Date.now(), value: identity }
        return identity
      })
      .finally(() => {
        if (this.pending?.value === value) {
          this.pending = undefined
        }
      })
    this.pending = { pid, value }
    return value
  }

  /** The pane's own config dir wins; account profile homes are fallbacks for switched accounts. */
  private async *configDirs(): AsyncGenerator<string> {
    yield this.configDir
    if (this.dataRoot) {
      for (const dir of await listClaudeProfileHomesAsync(this.dataRoot)) {
        if (dir !== this.configDir) {
          yield dir
        }
      }
    }
  }

  /** Accepts a file only when its recorded pid matches, so a recycled or stale file never labels another process. */
  private async readSession(pid: number): Promise<ClaudePeerIdentity | undefined> {
    for await (const dir of this.configDirs()) {
      // Open only the PID's public JSON; never enumerate session files or touch messaging keys.
      const file = await open(join(dir, 'sessions', `${pid}.json`), 'r').catch(() => null)
      if (!file) {
        continue
      }
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) {
          continue
        }
        const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > MAX_SESSION_BYTES) {
          continue
        }
        const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead))
        if (
          typeof value !== 'object' ||
          value === null ||
          !('pid' in value) ||
          value.pid !== pid ||
          !('name' in value) ||
          !displayString(value.name)
        ) {
          continue
        }
        return {
          agentName: value.name,
          agentPid: pid,
          ...('permissionMode' in value && displayString(value.permissionMode)
            ? { permissionMode: value.permissionMode }
            : {})
        }
      } catch {
        // Claude replaces session metadata while running; a later poll can retry.
      } finally {
        await file.close().catch(() => {})
      }
    }
    return undefined
  }
}
