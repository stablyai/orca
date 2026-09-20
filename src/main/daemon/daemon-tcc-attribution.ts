import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  inspectMacProcessCodeIdentity,
  type MacProcessCodeIdentity
} from './daemon-mac-code-identity'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { readVerifiedDaemonPid } from './daemon-pid-identity'
import { PROTOCOL_VERSION } from './types'

// 'severed': macOS can no longer resolve the daemon's TCC responsible process, so
// Accessibility/Automation grants on Orca silently stop covering its terminals (STA-3491), and
// TCC folders plus Local Network are denied to every unbundled tool under it (#20007).
// 'unknown' fails open: legacy pid files and probe failures must not trigger replacement.
export type MacDaemonTccAttributionHealth = 'intact' | 'severed' | 'unknown'

export type MacDaemonTccAttributionDependencies = {
  inspectCodeIdentity?: (pid: number) => Promise<MacProcessCodeIdentity>
}

type MacDaemonTccAttributionCacheEntry = {
  key: string
  pending: Promise<MacDaemonTccAttributionHealth>
  // Why: the verdict is cached per daemon generation, but the daemon's executable can vanish
  // from this path mid-generation (Squirrel parks, then deletes, the old bundle). Its absence
  // reopens the question without a pid-record change.
  resolvedExecutablePath: string | null
}

let cachedMacDaemonTccAttributionHealth: MacDaemonTccAttributionCacheEntry | null = null

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

/** Nearest `.app` ancestor of a path inside a bundle; null when the path is not bundled. */
export function findMacAppBundleRoot(executablePath: string): string | null {
  let current = executablePath
  while (true) {
    if (current.endsWith('.app')) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The daemon's own executable is what tccd resolves, so that is what decides. `spawnerExecPath`
 * alone cannot: an in-place update deletes and recreates it, so it always exists (#20007).
 */
export function classifyMacDaemonCodeIdentity(
  identity: MacProcessCodeIdentity,
  spawnerExecPath: string | null
): MacDaemonTccAttributionHealth {
  if (identity.status === 'unresolvable') {
    return 'severed'
  }
  if (identity.status === 'unavailable') {
    return spawnerExecPath !== null && existsSync(spawnerExecPath) ? 'intact' : 'unknown'
  }
  if (!existsSync(identity.executablePath)) {
    return 'severed'
  }
  // Why: a parked bundle still validates for a while, but its identity no longer matches any
  // grant recorded for the installed app (Local Network breaks after a single update).
  const bundleRoot = spawnerExecPath ? findMacAppBundleRoot(spawnerExecPath) : null
  if (
    bundleRoot &&
    !isPathInsideOrEqual(canonicalPath(bundleRoot), canonicalPath(identity.executablePath))
  ) {
    return 'severed'
  }
  return 'intact'
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
  protocolVersion = PROTOCOL_VERSION,
  dependencies: MacDaemonTccAttributionDependencies = {}
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
  const cached = cachedMacDaemonTccAttributionHealth
  if (
    cacheKey &&
    cached?.key === cacheKey &&
    (cached.resolvedExecutablePath === null || existsSync(cached.resolvedExecutablePath))
  ) {
    return await cached.pending
  }

  const entry: MacDaemonTccAttributionCacheEntry = {
    key: cacheKey ?? '',
    resolvedExecutablePath: null,
    pending: Promise.resolve('unknown')
  }
  entry.pending = (async (): Promise<MacDaemonTccAttributionHealth> => {
    const parsedPid = await readVerifiedDaemonPid(
      runtimeDir,
      socketPath,
      tokenPath,
      protocolVersion
    )
    if (!parsedPid) {
      return 'unknown'
    }
    if (parsedPid.spawnerExecPath && !existsSync(parsedPid.spawnerExecPath)) {
      return 'severed'
    }
    const identity = await (dependencies.inspectCodeIdentity ?? inspectMacProcessCodeIdentity)(
      parsedPid.pid
    )
    if (identity.status === 'resolved') {
      entry.resolvedExecutablePath = identity.executablePath
    }
    return classifyMacDaemonCodeIdentity(identity, parsedPid.spawnerExecPath)
  })()
  if (cacheKey) {
    cachedMacDaemonTccAttributionHealth = entry
  }
  const health = await entry.pending
  if (health === 'unknown' && cachedMacDaemonTccAttributionHealth === entry) {
    cachedMacDaemonTccAttributionHealth = null
  }
  return health
}
