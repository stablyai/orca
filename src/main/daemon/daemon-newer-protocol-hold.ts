import { readdirSync, readFileSync } from 'node:fs'
import type { NewerDaemonHeldScreen, NewerDaemonReopenResult } from '../../shared/newer-daemon-hold'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from './daemon-launch-paths'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { hasErrorCode } from './daemon-process-inspection'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { HistoryReader } from './history-reader'
import { PROTOCOL_VERSION } from './types'

const PID_FILE_PATTERN = /^daemon-v(\d+)\.pid$/

let heldProtocols: readonly number[] = []
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null

/**
 * Reads only a newer daemon's PID record and endpoint; this build cannot speak its protocol and
 * never touches its files. An unidentifiable owner falls back to the endpoint, the same
 * tiebreaker killStaleDaemon uses, so a dead leftover never holds a tab forever.
 */
async function classifyNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<ProcessLivenessVerdict['status']> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const byEndpoint = async (): Promise<ProcessLivenessVerdict['status']> => {
    let outcome = await probeSocketConnect(socketPath)
    if (outcome === 'unknown') {
      // Why: a stalled main loop can fire the probe timeout before a dead socket's refusal lands.
      await new Promise<void>((resolve) => setImmediate(resolve))
      outcome = await probeSocketConnect(socketPath)
    }
    return endpointIsProvenDead(outcome) ? 'exited' : 'unverifiable'
  }
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    // Why: a daemon removes its own record as it exits.
    return hasErrorCode(error, 'ENOENT') ? 'exited' : byEndpoint()
  }
  const parsed = parseDaemonPidFile(contents)
  // Why pid > 0: an empty record parses as pid 0, which names no process.
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return byEndpoint()
  }
  const identity = await inspectDaemonProcessIdentity(
    parsed.pid,
    socketPath,
    getDaemonTokenPath(runtimeDir, protocolVersion),
    parsed.startedAtMs
  )
  if (identity === 'match') {
    return 'live'
  }
  // Why mismatch is exited: the pid is gone or now names another process.
  return identity === 'mismatch' ? 'exited' : byEndpoint()
}

/** Holds restores for every live or unverifiable newer daemon in this profile's runtime dir. */
export async function discoverNewerProtocolHolds(runtimeDir: string): Promise<void> {
  let names: string[] = []
  try {
    names = readdirSync(runtimeDir)
  } catch {
    // No runtime dir means no newer daemon.
  }
  const versions = names
    .map((name) => Number(PID_FILE_PATTERN.exec(name)?.[1]))
    .filter((version) => Number.isSafeInteger(version) && version > PROTOCOL_VERSION)
  const verdicts = await Promise.all(
    versions.map((version) => classifyNewerProtocolDaemon(runtimeDir, version))
  )
  heldProtocols = versions.filter((_, index) => verdicts[index] !== 'exited')
}

export function isHoldingForNewerProtocolDaemon(): boolean {
  return heldProtocols.length > 0
}

/** A held session's saved screen, read from history without spawning; null when none was saved. */
export async function readNewerDaemonHeldScreen(
  sessionId: string,
  historyPath = getDaemonHistoryDir()
): Promise<NewerDaemonHeldScreen | null> {
  const restoreInfo = await new HistoryReader(historyPath)
    .detectColdRestore(sessionId)
    .catch(() => null)
  const payload = restoreInfo ? coldRestorePayloadFromInfo(restoreInfo) : null
  return payload ? { scrollback: payload.scrollback, cols: payload.cols, rows: payload.rows } : null
}

/** Signals only a verified daemon; confirmed only once the same classifier reads it exited. */
async function stopNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  const verdict = await classifyNewerProtocolDaemon(runtimeDir, protocolVersion)
  if (verdict !== 'live') {
    return verdict === 'exited'
  }
  const outcome = await killStaleDaemon(
    runtimeDir,
    getDaemonSocketPath(runtimeDir, protocolVersion),
    getDaemonTokenPath(runtimeDir, protocolVersion),
    protocolVersion
  )
  return (
    !outcome.liveOwnerSurvived &&
    (await classifyNewerProtocolDaemon(runtimeDir, protocolVersion)) === 'exited'
  )
}

/**
 * Stops every held newer daemon by signal only: this build cannot speak its protocol. Held
 * terminals are released only when every one is confirmed exited.
 */
export function reopenNewerDaemonTerminals(
  runtimeDir = getDaemonRuntimeDir()
): Promise<NewerDaemonReopenResult> {
  reopenInFlight ??= (async () => {
    try {
      const remaining: number[] = []
      for (const protocolVersion of heldProtocols) {
        if (!(await stopNewerProtocolDaemon(runtimeDir, protocolVersion))) {
          remaining.push(protocolVersion)
        }
      }
      heldProtocols = remaining
      return { reopened: remaining.length === 0 }
    } finally {
      reopenInFlight = null
    }
  })()
  return reopenInFlight
}
