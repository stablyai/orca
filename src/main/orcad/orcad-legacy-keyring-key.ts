/**
 * Reads a master key that hourly builds (#29412) kept in the OS keyring, so it can be copied into
 * the key file once. Never writes or deletes the item. Removable a few releases after it ships.
 */
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const SERVICE = 'orca-headless-secret-store'
// Why bounded: a locked keychain must not hang server start.
const KEYRING_TIMEOUT_MS = 5_000

export type OrcadLegacyKeyLookup = { key: string } | { failure: string }
export type OrcadLegacyKeyringReader = (account: string) => Promise<OrcadLegacyKeyLookup>

function lookupArgv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]] | null {
  if (platform === 'darwin') {
    return ['/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w', '-a']]
  }
  // Why only with a session bus: without one, dbus autolaunch can hang or spawn a daemon.
  return platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS
    ? ['secret-tool', ['lookup', 'service', SERVICE, 'account']]
    : null
}

export function resolveOrcadLegacyKeyringReader(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  runner: (spec: ProcessSpec) => Promise<ProcessResult> = runProcess
): OrcadLegacyKeyringReader | null {
  const argv = lookupArgv(platform, env)
  if (!argv) {
    return null
  }
  const [program, args] = argv
  return async (account) => {
    try {
      const result = await runner({
        program,
        args: [...args, account],
        timeoutMs: KEYRING_TIMEOUT_MS,
        maxOutputBytes: 4096
      })
      const key = result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
      if (key) {
        return { key }
      }
      return {
        failure: result.timedOut
          ? `timed out after ${KEYRING_TIMEOUT_MS / 1000}s`
          : `exited ${result.code}`
      }
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
