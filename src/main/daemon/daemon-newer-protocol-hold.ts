import type { NewerDaemonHeldScreen, NewerDaemonReopenResult } from '../../shared/newer-daemon-hold'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import { classifyDaemonGeneration, listDaemonPidFileProtocols } from './daemon-generation-liveness'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from './daemon-launch-paths'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { HistoryReader } from './history-reader'
import { PROTOCOL_VERSION } from './types'

let heldProtocols: readonly number[] = []
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null

/** Holds restores for every live or unverifiable newer daemon in this profile's runtime dir. */
export async function discoverNewerProtocolHolds(runtimeDir: string): Promise<void> {
  const versions = listDaemonPidFileProtocols(runtimeDir).filter(
    (version) => version > PROTOCOL_VERSION
  )
  const verdicts = await Promise.all(
    versions.map((version) => classifyDaemonGeneration(runtimeDir, version))
  )
  heldProtocols = versions.filter((_, index) => verdicts[index] !== 'exited')
}

export function isHoldingForNewerProtocolDaemon(): boolean {
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
    (await classifyDaemonGeneration(runtimeDir, protocolVersion)) === 'exited'
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
