import type {
  NewerDaemonHeldScreen,
  NewerDaemonReopenResult
} from '../../../../shared/terminal/daemon/newer-daemon-hold'
import { coldRestorePayloadFromInfo } from '../../history/restoration/cold-restore-payload-cache'
import {
  classifyDaemonGeneration,
  listDaemonPidFileProtocols
} from '../../launch/daemon-generation-liveness'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from '../../launch/daemon-launch-paths'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../launch/daemon-spawner'
import { readFile } from 'node:fs/promises'
import { parseDaemonPidFile } from '../../endpoint/identity/daemon-pid-file-parse'
import { inspectProcessLiveness } from '../../endpoint/identity/daemon-process-inspection'
import { killStaleDaemon } from '../../launch/daemon-stale-kill'
import { HistoryReader } from '../../history/restoration/history-reader'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

let heldProtocols: readonly number[] = []
let heldDaemonPids = new Map<number, number>()
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null

/** Holds restores for every live or unverifiable newer daemon in this profile's runtime dir. */
export async function discoverNewerProtocolHolds(runtimeDir: string): Promise<void> {
  const versions = listDaemonPidFileProtocols(runtimeDir).filter(
    (version) => version > PROTOCOL_VERSION
  )
  const verdicts = await Promise.all(
    versions.map((version) => classifyDaemonGeneration(runtimeDir, version))
  )
  const held = versions.filter((_, index) => verdicts[index] !== 'exited')
  const pids = await Promise.all(held.map((version) => readHeldDaemonPid(runtimeDir, version)))
  heldProtocols = held
  heldDaemonPids = new Map(
    held.flatMap((version, index) => {
      const pid = pids[index]
      return pid === null ? [] : [[version, pid] as const]
    })
  )
}

// Only a pid read while the daemon was held can later prove its exit; a missing file proves nothing then.
async function readHeldDaemonPid(runtimeDir: string, version: number): Promise<number | null> {
  try {
    const parsed = parseDaemonPidFile(await readFile(getDaemonPidPath(runtimeDir, version), 'utf8'))
    return parsed && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch {
    return null
  }
}

export function isHoldingForNewerProtocolDaemon(): boolean {
  return heldProtocols.length > 0
}

function heldDaemonProcessGone(version: number): boolean {
  const pid = heldDaemonPids.get(version)
  return pid === undefined || inspectProcessLiveness(pid).status === 'exited'
}

/** Whether the hold still stands: a held daemon whose recorded process is gone has exited since startup. */
export function recheckNewerProtocolHold(): boolean {
  // A stop in progress removes its pid file before its terminals end; Reopen decides those exits itself.
  if (heldProtocols.length === 0 || reopenInFlight) {
    return heldProtocols.length > 0
  }
  const exited = heldProtocols.filter(
    (version) => heldDaemonPids.has(version) && heldDaemonProcessGone(version)
  )
  if (exited.length > 0) {
    heldProtocols = heldProtocols.filter((version) => !exited.includes(version))
  }
  return heldProtocols.length > 0
}

/** Read the held session's saved screen without spawning. */
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
  const verdict = await classifyDaemonGeneration(runtimeDir, protocolVersion)
  if (verdict !== 'live') {
    // A stopping daemon unlinks its pid file before its terminals end; its remembered process must be gone too.
    return verdict === 'exited' && heldDaemonProcessGone(protocolVersion)
  }
  const outcome = await killStaleDaemon(
    runtimeDir,
    getDaemonSocketPath(runtimeDir, protocolVersion),
    getDaemonTokenPath(runtimeDir, protocolVersion),
    protocolVersion
  )
  return (
    !outcome.liveOwnerSurvived &&
    (await classifyDaemonGeneration(runtimeDir, protocolVersion)) === 'exited' &&
    heldDaemonProcessGone(protocolVersion)
  )
}

/** Release held terminals only after every newer daemon is confirmed exited; this build cannot use their RPCs. */
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
