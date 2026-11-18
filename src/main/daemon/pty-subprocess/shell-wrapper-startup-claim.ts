import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartupCommandFallback } from '../sessions/session-shell-ready-barrier'
import {
  discardStagedStartupCommandAsync,
  stageStartupCommandAsync,
  STAGED_STARTUP_COMMAND_PREFIX,
  type StartupCommandStaging
} from '../../../shared/shell/launch/startup-command-staging'
import {
  POSIX_SHELL_STARTUP_CLAIM_ENV,
  POSIX_SHELL_STARTUP_COMMAND_ENV
} from '../../pty/shell-startup/posix-shell-startup-command'

/** The zsh wrapper runs the launch; the readiness-timeout fallback types it only if it wins the claim first. */
export type ShellWrapperStartup = {
  staging: StartupCommandStaging
  claimPath: string
}

/** A launch the zsh wrapper could run; staged and handed to the shell only once the plan picks it. */
export type ShellWrapperStartupCandidate = {
  command: string
  shellPath: string
  orcaBuiltLine: boolean
  claimPath: string
}

// Linux caps one env string at 128 KiB; only an unstaged (stage-failed) line can come near it.
const MAX_WRAPPER_STARTUP_COMMAND_BYTES = 32 * 1024

/** Long or multiline lines run from a staged script so the prompt stays out of scrollback and history. */
export async function stageShellWrapperStartup(
  candidate: ShellWrapperStartupCandidate,
  env: Record<string, string>
): Promise<ShellWrapperStartup | null> {
  const staging = await stageStartupCommandAsync(candidate)
  const line = staging.command.replace(/(\r\n|\r|\n)$/, '')
  if (Buffer.byteLength(line) > MAX_WRAPPER_STARTUP_COMMAND_BYTES) {
    void discardStagedStartupCommandAsync(staging)
    return null
  }
  env[POSIX_SHELL_STARTUP_COMMAND_ENV] = line
  env[POSIX_SHELL_STARTUP_CLAIM_ENV] = candidate.claimPath
  return { staging, claimPath: candidate.claimPath }
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

// Built outside the create scope so releasing the builder frees the request it captured.
export function createStartupCommandFallback(
  claimPath: string,
  typeLaunch: () => string
): StartupCommandFallback {
  let pendingLaunch: (() => string) | null = typeLaunch
  return {
    claim: () => takeShellWrapperStartupClaim(claimPath),
    build: () => pendingLaunch?.() ?? '',
    release: () => {
      pendingLaunch = null
    }
  }
}
