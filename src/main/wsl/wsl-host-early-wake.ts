/**
 * Boots the WSL distros the last run had open work on, at the very start of the next launch, so
 * the distro boot (seconds on a slow PC) overlaps the app's own startup instead of following it.
 * Only distros the user had open work on are ever listed (E9: never wake one they did not open).
 */
import { join } from 'node:path'
import { z } from 'zod'
import { spawnProcess } from '@orca/process-host'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { WslDistroNameSchema } from '../../shared/wsl-host-deployment-link'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { resolveWslExecutablePath } from './wsl-executable-path'

const WAKE_FILE = 'orca-wsl-host-wake.json'
const MAX_WAKE_FILE_BYTES = 16 * 1024

const WakeListSchema = z.object({ version: z.literal(1), distros: z.array(WslDistroNameSchema) })

function wakeFile(userDataPath: string): string {
  return join(userDataPath, WAKE_FILE)
}

function readWakeList(userDataPath: string): string[] {
  try {
    const { buffer } = readNodeFileSyncWithinLimit(wakeFile(userDataPath), MAX_WAKE_FILE_BYTES)
    return WakeListSchema.parse(JSON.parse(buffer.toString('utf8'))).distros
  } catch {
    return []
  }
}

/** Saves the distros with open work right now; called whenever that set changes. */
export function rememberWslHostsToWake(userDataPath: string, distros: readonly string[]): void {
  const next = [...new Set(distros)].sort()
  const current = readWakeList(userDataPath)
  if (current.length === next.length && current.every((distro, i) => distro === next[i])) {
    return
  }
  try {
    writeSecureJsonFileWithinLimit(
      wakeFile(userDataPath),
      { version: 1, distros: next },
      MAX_WAKE_FILE_BYTES
    )
  } catch (error) {
    console.warn('[wsl-hosts] Could not save the distros to wake at next launch:', error)
  }
}

export type WslWakeSpawn = (distro: string) => void

function spawnWake(distro: string): void {
  const child = spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['true']),
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    stdio: 'ignore'
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Starts booting each remembered distro that is still a registered WSL host. Fire and forget: the
 * connect that follows does the real work and reports any failure.
 */
export function wakeRememberedWslHosts(
  userDataPath: string,
  spawn: WslWakeSpawn = spawnWake
): string[] {
  const remembered = readWakeList(userDataPath)
  if (remembered.length === 0) {
    return []
  }
  let registered: Set<string>
  try {
    registered = new Set(
      readWslHostDeployments(userDataPath).deployments.map((record) =>
        wslDistroHolderKey(record.distro)
      )
    )
  } catch {
    return []
  }
  const woken = remembered.filter((distro) => registered.has(wslDistroHolderKey(distro)))
  for (const distro of woken) {
    try {
      spawn(distro)
    } catch (error) {
      console.warn(`[wsl-hosts] Could not start waking ${distro}:`, error)
    }
  }
  return woken
}
