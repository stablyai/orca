import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { readVerifiedDaemonPid } from './daemon-pid-identity'
import { getPsParentPidAsync } from './daemon-process-identity-query'
import { MAC_TERMINAL_HOST_EXECUTABLE } from './macos-daemon-bundle'
import { PROTOCOL_VERSION } from './types'

const LAUNCHD_PID = 1

// Unknown attribution must not trigger daemon replacement.
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

/** Legacy forked daemons use the spawning app as their TCC grant subject (STA-3491). */
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
    // The launchd terminal host is its own responsible process.
    if (basename(parsedPid.spawnerExecPath) === MAC_TERMINAL_HOST_EXECUTABLE) {
      return 'intact'
    }
    // Once the forking app exits, tccd sees each new child as its own session, so session-scoped grants never stick (#12971).
    const parentPid = await getPsParentPidAsync(parsedPid.pid)
    if (parentPid === null) {
      return 'unknown'
    }
    return parentPid === LAUNCHD_PID ? 'severed' : 'intact'
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
