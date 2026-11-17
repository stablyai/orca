import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STAGED_STARTUP_COMMAND_PREFIX,
  type StartupCommandStaging
} from '../../../shared/shell/launch/startup-command-staging'

/** The zsh wrapper runs the launch; the readiness-timeout fallback types it only if it wins the claim first. */
export type ShellWrapperStartup = {
  staging: StartupCommandStaging
  claimPath: string
}

// The wrapper and the daemon both unlink this file; unlink succeeds for exactly one of them.
export function createShellWrapperStartupClaim(): string | null {
  const claimPath = join(
    tmpdir(),
    `${STAGED_STARTUP_COMMAND_PREFIX}claim-${randomBytes(8).toString('hex')}.sh`
  )
  try {
    writeFileSync(claimPath, '', { mode: 0o600, flag: 'wx' })
    return claimPath
  } catch {
    return null
  }
}

export function takeShellWrapperStartupClaim(claimPath: string): boolean {
  try {
    unlinkSync(claimPath)
    return true
  } catch {
    return false
  }
}
