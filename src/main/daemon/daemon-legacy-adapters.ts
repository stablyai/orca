import { readFileSync } from 'node:fs'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { parseDaemonPidFile, salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  unlinkDaemonPidFileWhen,
  unlinkOwnedDaemonTokenFile
} from './daemon-spawner'
import { daemonTokenIsProvenAbsent, retireTokenlessDaemon } from './daemon-tokenless-retirement'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

const LIVE_DAEMON_PROBE_RETRY_DELAYS_MS = [250, 750]

/** 'unknown' is load-bearing: EPERM, an unreadable pid file, or any other failed check proves nothing. */
type LegacyDaemonPidLiveness = 'alive' | 'gone' | 'no-record' | 'unknown'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** `content` is the exact record the verdict was drawn from, so cleanup can be fenced to it. */
type LegacyDaemonPidCheck = { liveness: LegacyDaemonPidLiveness; content: string | null }

function readLegacyDaemonPidCheck(
  runtimeDir: string,
  protocolVersion: number
): LegacyDaemonPidCheck {
  let content: string
  try {
    content = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    return { liveness: hasErrorCode(error, 'ENOENT') ? 'no-record' : 'unknown', content: null }
  }
  const pid = parseDaemonPidFile(content)?.pid ?? salvagePidFromCorruptDaemonRecord(content)
  if (pid === null) {
    return { liveness: 'no-record', content }
  }
  try {
    process.kill(pid, 0)
    return { liveness: 'alive', content }
  } catch (error) {
    // Why: only ESRCH proves absence; Windows reports EPERM for a live process it won't open.
    return { liveness: hasErrorCode(error, 'ESRCH') ? 'gone' : 'unknown', content }
  }
}

function readTokenSnapshot(tokenPath: string): string | null {
  try {
    return readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return null
  }
}

async function probeLegacyDaemonSocket(
  socketPath: string,
  pidLiveness: () => LegacyDaemonPidLiveness
): Promise<boolean> {
  if (await probeSocket(socketPath)) {
    return true
  }
  // Why: a cold start right after an update can starve a live daemon's accept loop past one probe.
  const liveness = pidLiveness()
  if (liveness === 'gone' || liveness === 'no-record') {
    return false
  }
  for (const delayMs of LIVE_DAEMON_PROBE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (await probeSocket(socketPath)) {
      return true
    }
  }
  return false
}

// Why: a leaked token plus a recycled pid later turns an identity check into a PowerShell spawn, but
// deleting a live daemon's token strands its sessions forever (no client can authenticate, and it
// never idles out), so both the pid and the endpoint must prove the daemon is gone.
async function removeProvablyStaleLegacyArtifacts(
  runtimeDir: string,
  protocolVersion: number
): Promise<void> {
  // Why snapshot first: a replacement can publish between these checks and the unlinks, and
  // the claim-then-compare unlinks below only remove the exact records that were judged.
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const token = readTokenSnapshot(tokenPath)
  const { liveness: pidLiveness, content: pidRecord } = readLegacyDaemonPidCheck(
    runtimeDir,
    protocolVersion
  )
  if (pidLiveness !== 'gone' && pidLiveness !== 'no-record') {
    console.warn(
      `[daemon] Keeping v${protocolVersion} daemon token: endpoint unreachable but pid liveness is ${pidLiveness}`
    )
    return
  }
  const endpoint = await probeSocketConnect(getDaemonSocketPath(runtimeDir, protocolVersion))
  if (!endpointIsProvenDead(endpoint)) {
    console.warn(
      `[daemon] Keeping v${protocolVersion} daemon token: endpoint probe was ${endpoint}, not proof of exit`
    )
    return
  }
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  const removed = [
    pidRecord !== null && unlinkDaemonPidFileWhen(pidPath, (content) => content === pidRecord)
      ? pidPath
      : null,
    token !== null && unlinkOwnedDaemonTokenFile(tokenPath, token) ? tokenPath : null
  ]
  for (const stalePath of removed) {
    if (stalePath) {
      console.warn(
        `[daemon] Removed stale v${protocolVersion} daemon file ${stalePath} (pid ${pidLiveness}, endpoint ${endpoint})`
      )
    }
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    const pidLiveness = (): LegacyDaemonPidLiveness =>
      readLegacyDaemonPidCheck(runtimeDir, protocolVersion).liveness
    if (!(await probeLegacyDaemonSocket(socketPath, pidLiveness))) {
      await removeProvablyStaleLegacyArtifacts(runtimeDir, protocolVersion)
      continue
    }
    if (daemonTokenIsProvenAbsent(tokenPath)) {
      // Why off the startup path: termination waits seconds, and nothing here depends on it.
      void retireTokenlessDaemon(socketPath, tokenPath, protocolVersion).catch((error) => {
        console.warn(`[daemon] Tokenless v${protocolVersion} daemon retirement failed`, error)
      })
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
