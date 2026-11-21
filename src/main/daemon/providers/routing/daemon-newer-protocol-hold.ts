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
import { access, readFile } from 'node:fs/promises'
import { parseDaemonPidFile } from '../../endpoint/identity/daemon-pid-file-parse'
import {
  inspectProcessLiveness,
  queryWindowsProcess,
  readLinuxProcessStartedAtMs,
  readMacosProcessStartedAtMs
} from '../../endpoint/identity/daemon-process-inspection'
import {
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from '../../endpoint/identity/daemon-process-start-time'
import { WINDOWS_CREATION_TIME_TOLERANCE_MS } from '../../endpoint/identity/daemon-incarnation-evidence-types'
import { killStaleDaemon } from '../../launch/daemon-stale-kill'
import { HistoryReader } from '../../history/restoration/history-reader'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

type HeldDaemonProcess = { pid: number; startedAtMs: number | null }

let heldProtocols: readonly number[] = []
let heldRuntimeDir = ''
let heldDaemonProcesses = new Map<number, HeldDaemonProcess>()
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null
let recheckInFlight: Promise<boolean> | null = null

/** Holds restores for every live or unverifiable newer daemon in this profile's runtime dir. */
export async function discoverNewerProtocolHolds(runtimeDir: string): Promise<void> {
  const versions = listDaemonPidFileProtocols(runtimeDir).filter(
    (version) => version > PROTOCOL_VERSION
  )
  const verdicts = await Promise.all(
    versions.map((version) => classifyDaemonGeneration(runtimeDir, version))
  )
  const held = versions.filter((_, index) => verdicts[index] !== 'exited')
  const processes = await Promise.all(
    held.map((version) => readHeldDaemonProcess(runtimeDir, version))
  )
  heldProtocols = held
  heldRuntimeDir = runtimeDir
  heldDaemonProcesses = new Map(
    held.flatMap((version, index) => {
      const recorded = processes[index]
      return recorded === null ? [] : [[version, recorded] as const]
    })
  )
}

// Only a pid read while the daemon was held can later prove its exit; a missing file proves nothing then.
async function readHeldDaemonProcess(
  runtimeDir: string,
  version: number
): Promise<HeldDaemonProcess | null> {
  try {
    const parsed = parseDaemonPidFile(await readFile(getDaemonPidPath(runtimeDir, version), 'utf8'))
    return parsed && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid, startedAtMs: parsed.startedAtMs }
      : null
  } catch {
    return null
  }
}

export function isHoldingForNewerProtocolDaemon(): boolean {
  return heldProtocols.length > 0
}

async function processStartedAtMs(pid: number): Promise<number | 'missing' | null> {
  if (process.platform === 'win32') {
    const evidence = await queryWindowsProcess(pid)
    return evidence.status === 'missing'
      ? 'missing'
      : evidence.status === 'present'
        ? evidence.startedAtMs
        : null
  }
  if (process.platform === 'linux') {
    return readLinuxProcessStartedAtMs(pid)
  }
  return process.platform === 'darwin' ? readMacosProcessStartedAtMs(pid) : null
}

async function pidFileExists(version: number): Promise<boolean> {
  try {
    await access(getDaemonPidPath(heldRuntimeDir, version))
    return true
  } catch {
    return false
  }
}

/** Whether the held daemon's remembered process is gone; a reused pid names a process that started at another time. */
async function heldDaemonProcessGone(version: number, pidFileGone: boolean): Promise<boolean> {
  const held = heldDaemonProcesses.get(version)
  if (held === undefined) {
    return true
  }
  const liveness = inspectProcessLiveness(held.pid).status
  if (liveness !== 'live') {
    return liveness === 'exited'
  }
  // Only a daemon whose pid file is gone can have exited; a running one is never probed.
  const pidFilePresent = !pidFileGone && (await pidFileExists(version))
  if (held.startedAtMs === null || pidFilePresent) {
    return false
  }
  const startedAtMs = await processStartedAtMs(held.pid)
  if (startedAtMs === 'missing') {
    return true
  }
  const tolerance =
    process.platform === 'win32' ? WINDOWS_CREATION_TIME_TOLERANCE_MS : START_TIME_TOLERANCE_MS
  return (
    startedAtMs !== null && !startTimesWithinTolerance(startedAtMs, held.startedAtMs, tolerance)
  )
}

/** Whether the hold still stands: a held daemon whose recorded process is gone has exited since startup. */
export function recheckNewerProtocolHold(): Promise<boolean> {
  // A stop in progress removes its pid file before its terminals end; Reopen decides those exits itself.
  if (heldProtocols.length === 0 || reopenInFlight) {
    return Promise.resolve(heldProtocols.length > 0)
  }
  // A burst of held refusals shares one check.
  recheckInFlight ??= (async () => {
    try {
      const checked = heldProtocols.filter((version) => heldDaemonProcesses.has(version))
      const gone = await Promise.all(
        checked.map((version) => heldDaemonProcessGone(version, false))
      )
      const exited = checked.filter((_, index) => gone[index])
      if (exited.length > 0) {
        heldProtocols = heldProtocols.filter((version) => !exited.includes(version))
      }
      return heldProtocols.length > 0
    } finally {
      recheckInFlight = null
    }
  })()
  return recheckInFlight
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
    return verdict === 'exited' && (await heldDaemonProcessGone(protocolVersion, true))
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
    (await heldDaemonProcessGone(protocolVersion, true))
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
