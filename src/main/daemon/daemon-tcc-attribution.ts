import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { readVerifiedDaemonPid } from './daemon-pid-identity'
import { PROTOCOL_VERSION } from './types'

const execFileAsync = promisify(execFile)

// 'severed': macOS can no longer resolve the daemon's TCC responsible process, so
// Accessibility/Automation grants on Orca silently stop covering its terminals (STA-3491).
// 'unknown' fails open: legacy pid files and probe failures must not trigger replacement.
export type MacDaemonTccAttributionHealth = 'intact' | 'severed' | 'unknown'

let cachedMacDaemonTccAttributionHealth: {
  key: string
  pending: Promise<MacDaemonTccAttributionHealth>
} | null = null

function getMacDaemonTccAttributionCacheKey(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion: number
): string | null {
  try {
    const pidRecord = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    const parsedPid = parseDaemonPidFile(pidRecord)
    if (!parsedPid) {
      return null
    }
    const spawnerExists = parsedPid.spawnerExecPath ? existsSync(parsedPid.spawnerExecPath) : null
    return JSON.stringify([socketPath, tokenPath, protocolVersion, pidRecord, spawnerExists])
  } catch {
    return null
  }
}

export async function checkMacProcessTccAttributionIntact(pid: number): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/codesign', ['-v', `+${pid}`], { timeout: 2_000 })
    return true
  } catch (err: unknown) {
    const execErr = err as { code?: unknown; killed?: boolean }
    if (typeof execErr?.code === 'number' && !execErr.killed) {
      return false
    }
    return true
  }
}

/**
 * macOS pins a process's TCC "responsible process" to the binary that forked it,
 * by file reference. If that binary path disappears while the daemon survives, tccd
 * cannot resolve the grant subject for the daemon's terminals (STA-3491).
 */
export async function getMacDaemonTccAttributionHealth(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<MacDaemonTccAttributionHealth> {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }
  const cacheKey = getMacDaemonTccAttributionCacheKey(
    runtimeDir,
    socketPath,
    tokenPath,
    protocolVersion
  )
  if (cacheKey && cachedMacDaemonTccAttributionHealth?.key === cacheKey) {
    return await cachedMacDaemonTccAttributionHealth.pending
  }

  const pending = (async (): Promise<MacDaemonTccAttributionHealth> => {
    const parsedPid = await readVerifiedDaemonPid(
      runtimeDir,
      socketPath,
      tokenPath,
      protocolVersion
    )
    if (!parsedPid) {
      return 'unknown'
    }
    if (!parsedPid.spawnerExecPath) {
      return 'unknown'
    }
    if (!existsSync(parsedPid.spawnerExecPath)) {
      return 'severed'
    }
    const intact = await checkMacProcessTccAttributionIntact(parsedPid.pid)
    return intact ? 'intact' : 'severed'
  })()
  if (cacheKey) {
    cachedMacDaemonTccAttributionHealth = { key: cacheKey, pending }
  }
  const health = await pending
  if (
    health === 'unknown' &&
    cachedMacDaemonTccAttributionHealth?.key === cacheKey &&
    cachedMacDaemonTccAttributionHealth.pending === pending
  ) {
    cachedMacDaemonTccAttributionHealth = null
  }
  return health
}
