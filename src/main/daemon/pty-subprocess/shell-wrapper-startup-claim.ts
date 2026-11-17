import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
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
export async function createShellWrapperStartupClaim(): Promise<string | null> {
  const claimPath = join(
    tmpdir(),
    `${STAGED_STARTUP_COMMAND_PREFIX}claim-${randomBytes(8).toString('hex')}.sh`
  )
  try {
    await writeFile(claimPath, '', { mode: 0o600, flag: 'wx' })
    return claimPath
  } catch {
    return null
  }
}

export async function takeShellWrapperStartupClaim(claimPath: string): Promise<boolean> {
  try {
    await unlink(claimPath)
    return true
  } catch {
    return false
  }
}
