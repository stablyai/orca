import { existsSync, readFileSync } from 'node:fs'
import { runProcess } from '../../shared/child-process/run-process'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { readVerifiedDaemonPid } from './daemon-pid-identity'
import { PROTOCOL_VERSION } from './types'
import { hasDaemonTccDenial, rememberDaemonTccDenial } from './daemon-tcc-denial-record'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'

// Only measured access divergence is severed; code/path warnings are at-risk and fail open.
export type MacDaemonTccAttributionHealth = 'intact' | 'at-risk' | 'severed' | 'unknown'

const CODESIGN_PATH = '/usr/bin/codesign'
const CODESIGN_PROBE_TIMEOUT_MS = 2_000
// Why: this is the one failure that means "the running image is gone", as opposed to a bad
// pid or a codesign that could not run; anything else is inconclusive and must fail open.
const CODESIGN_NO_GUEST_MARKER = 'host has no guest with the requested attributes'
// Why bounded: the verdict can flip under a daemon this process already saw intact, so 'intact'
// is only trusted for a short while. 'severed' never heals without a daemon restart, which
// rewrites the pid record and so the cache key; 'unknown' is re-derived every ask.
const INTACT_VERDICT_TTL_MS = 30_000

export type MacProcessCodeIdentity = 'valid' | 'unresolvable' | 'unknown'

/** Code identity is diagnostic evidence, not a probe of the daemon's TCC grants. */
export async function inspectMacProcessCodeIdentity(pid: number): Promise<MacProcessCodeIdentity> {
  if (process.platform !== 'darwin' || !existsSync(CODESIGN_PATH)) {
    return 'unknown'
  }
  try {
    const result = await runProcess({
      program: CODESIGN_PATH,
      args: ['--verify', `+${pid}`],
      timeoutMs: CODESIGN_PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096
    })
    if (result.timedOut) {
      return 'unknown'
    }
    if (result.code === 0) {
      return 'valid'
    }
    return result.stderr.includes(CODESIGN_NO_GUEST_MARKER) ? 'unresolvable' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Access divergence wins over diagnostic code-identity results for this incarnation. */
export function recordMacDaemonProtectedPathDenial(
  record: ParsedDaemonPid | null,
  pidPath?: string | null
): void {
  if (process.platform !== 'darwin' || !record) {
    return
  }
  rememberDaemonTccDenial(record, pidPath)
  cachedMacDaemonTccAttributionHealth = null
}

let cachedMacDaemonTccAttributionHealth: {
  key: string
  pending: Promise<MacDaemonTccAttributionHealth>
  expiresAtMs: number
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

/** Unknown and at-risk fail open; only measured denial changes spawn admission. */
export async function getMacDaemonTccAttributionHealth(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  inspectCodeIdentity: (
    pid: number
  ) => Promise<MacProcessCodeIdentity> = inspectMacProcessCodeIdentity,
  evidenceOnly = false
): Promise<MacDaemonTccAttributionHealth> {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  const record = readDaemonPidRecord(pidPath)
  if (record && hasDaemonTccDenial(record, pidPath)) {
    return 'severed'
  }
  // Spawn admission only needs measured denial; diagnostic subprocesses stay off this path.
  if (evidenceOnly) {
    return 'unknown'
  }
  const cacheKey = getMacDaemonTccAttributionCacheKey(
    runtimeDir,
    socketPath,
    tokenPath,
    protocolVersion
  )
  const cached = cachedMacDaemonTccAttributionHealth
  if (cacheKey && cached?.key === cacheKey && Date.now() < cached.expiresAtMs) {
    return await cached.pending
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
    if (hasDaemonTccDenial(parsedPid, pidPath)) {
      return 'severed'
    }
    if (!parsedPid.spawnerExecPath) {
      return 'unknown'
    }
    if (!existsSync(parsedPid.spawnerExecPath)) {
      return 'at-risk'
    }
    const identity = await inspectCodeIdentity(parsedPid.pid)
    if (hasDaemonTccDenial(parsedPid, pidPath)) {
      return 'severed'
    }
    return identity === 'unresolvable' ? 'at-risk' : identity === 'valid' ? 'intact' : 'unknown'
  })()
  if (cacheKey) {
    // Why the far expiry while pending: concurrent callers must share one probe; the real TTL is set below.
    cachedMacDaemonTccAttributionHealth = { key: cacheKey, pending, expiresAtMs: Infinity }
  }
  const health = await pending
  if (
    getMacDaemonTccAttributionCacheKey(runtimeDir, socketPath, tokenPath, protocolVersion) !==
    cacheKey
  ) {
    return 'unknown'
  }
  if (
    cacheKey &&
    cachedMacDaemonTccAttributionHealth?.key === cacheKey &&
    cachedMacDaemonTccAttributionHealth.pending === pending
  ) {
    // Why: a severed lineage never heals, so its verdict holds until the pid record changes;
    // 'unknown' is a failed probe and must retry.
    cachedMacDaemonTccAttributionHealth =
      health === 'unknown'
        ? null
        : {
            key: cacheKey,
            pending,
            expiresAtMs: health === 'severed' ? Infinity : Date.now() + INTACT_VERDICT_TTL_MS
          }
  }
  return health
}
