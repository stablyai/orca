/**
 * Boots the distro of the WSL host the last run had focused, at the very start of the next launch,
 * so the boot (seconds on a slow PC) overlaps the app's own startup instead of following it. Only
 * the focused host is listed (E9: a launch boots the focused host, never others with saved tabs).
 */
import { rmSync } from 'node:fs'
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

/** Saves the distro of the host the user is focused on (or none); called on each focus entry. */
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

/**
 * WSL hosts turned off: the file is the only thing the next launch reads (before settings load),
 * so it goes now, synchronously. If it can't be deleted it is emptied instead, and if that fails
 * too the failure is logged; a missing or unreadable file wakes nothing.
 */
export function forgetWslHostsToWake(userDataPath: string): void {
  try {
    rmSync(wakeFile(userDataPath), { force: true })
  } catch (error) {
    console.warn('[wsl-hosts] Could not delete the early-wake list; emptying it:', error)
    rememberWslHostsToWake(userDataPath, [])
  }
}

/** A removed host is never woken early, even before its record is gone. */
export function forgetWslHostToWake(userDataPath: string, distro: string): void {
  const key = wslDistroHolderKey(distro)
  const remembered = readWakeList(userDataPath)
  if (remembered.some((entry) => wslDistroHolderKey(entry) === key)) {
    rememberWslHostsToWake(
      userDataPath,
      remembered.filter((entry) => wslDistroHolderKey(entry) !== key)
    )
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
    // A host whose Remove is pending must not be booted: that would undo its stop's proof.
    registered = new Set(
      readWslHostDeployments(userDataPath)
        .deployments.filter((record) => !record.pendingStop)
        .map((record) => wslDistroHolderKey(record.distro))
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
