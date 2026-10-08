import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RELAY_PID_FILENAME, RELAY_VERSION_FILENAME } from '../shared/relay-artifacts'
import { relayLogLine } from './relay-diagnostic-log'

/**
 * Record this daemon's PID in its version dir once it owns its socket, so version GC can
 * tell a stale socket from a live daemon without connecting to one that is about to idle.
 */
export function publishRelayPid(entry: string | undefined = process.argv[1]): void {
  if (!entry) {
    return
  }
  let temporary: string | null = null
  try {
    const versionDir = dirname(realpathSync(entry))
    // Why: only an installed version dir carries `.version`; a dev or test build dir is not GC'd.
    if (!existsSync(join(versionDir, RELAY_VERSION_FILENAME))) {
      return
    }
    temporary = join(versionDir, `${RELAY_PID_FILENAME}.${process.pid}.tmp`)
    writeFileSync(temporary, `${process.pid}\n`, { mode: 0o600 })
    // Why rename: GC must never read a half-written PID as a different, dead process.
    renameSync(temporary, join(versionDir, RELAY_PID_FILENAME))
    temporary = null
  } catch (error) {
    relayLogLine(
      `[relay] Could not record relay PID: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    if (temporary) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // A leftover temp file is inert; GC reads only the renamed name.
      }
    }
  }
}
