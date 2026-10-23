import { posix as pathPosix } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'
import { isCodexAccountSessionBridgeStopping } from './codex-account-session-bridge'
import {
  createCodexAccountStateDb,
  healPendingCodexAccountThreads
} from './codex-account-session-index-heal'
import { buildWslHealInvocation, type CodexSettledThreadRead } from './codex-session-index-heal'
import { parseCodexRolloutThreadId } from './codex-session-index-heal-state'
import {
  buildWslCodexSessionBridgeShellCommand,
  WSL_SESSION_BRIDGE_TIMEOUT_MS
} from './wsl-codex-session-bridge-script'

export { buildWslCodexSessionBridgeShellCommand } from './wsl-codex-session-bridge-script'

export type WslCodexSessionBridgeTarget = {
  distro: string
  systemCodexHomePath: string
  managedCodexHomePath: string
}

export type WslCodexSessionBridgeLinuxPaths = {
  systemSessionsRoot: string
  managedSessionsRoot: string
  managedHomePath: string
  indexPendingRoot: string
}

export type WslCodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
  /** Marker names in `indexPendingRoot`: rollout file names Codex has yet to index. */
  pendingRollouts: string[]
  /** Some rollout could not be linked; the rest of the summary is still accurate. */
  bridgeFailed: boolean
}

// Why: Windows cannot take SQLite's locks over \\wsl.localhost, so the host
// cannot diff bridged threads against the guest's Codex index the way the
// native bridge does. A marker per linked rollout records the work instead,
// and dies when `thread/read` settles that thread.
const WSL_INDEX_PENDING_DIR_NAME = '.orca-index-pending'

// Why: app-server answers `initialize` only once Codex's startup backfill is
// complete; on a home an older Orca filled before Codex ever opened it, that
// is the minutes-long backfill itself. Codex's own 30s gate bounds the case
// where another process holds the backfill.
const WSL_STATE_DB_OPEN_TIMEOUT_MS = 15 * 60_000

// Why: marker names are ~75 bytes, so this reports ~900k pending rollouts
// before the summary line could be truncated away.
const WSL_SESSION_BRIDGE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

type WslBridgeDependencies = {
  openStateDb: typeof createCodexAccountStateDb
  healPending: typeof healPendingCodexAccountThreads
}

const defaultWslBridgeDependencies: WslBridgeDependencies = {
  openStateDb: createCodexAccountStateDb,
  healPending: healPendingCodexAccountThreads
}

const emptySummary: WslCodexSessionBridgeSummary = {
  scannedFiles: 0,
  linkedFiles: 0,
  pendingRollouts: [],
  bridgeFailed: false
}
const backgroundWslSessionBridgeTasks = new Map<string, Promise<void>>()
// A complete backfill stays complete, so each home needs the startup probe once per run.
const homesWithCompleteIndex = new Set<string>()

export function startWslCodexSessionBridgeInBackground(
  target: WslCodexSessionBridgeTarget,
  dependenciesOverride: Partial<WslBridgeDependencies> = {}
): Promise<void> {
  if (isCodexAccountSessionBridgeStopping()) {
    return Promise.resolve()
  }
  const taskKey = getWslSessionBridgeTaskKey(target)
  const existingTask = backgroundWslSessionBridgeTasks.get(taskKey)
  if (existingTask) {
    return existingTask
  }

  const task = bridgeAndIndexWslCodexSessions(target, {
    ...defaultWslBridgeDependencies,
    ...dependenciesOverride
  })
    .catch((error: unknown) => {
      console.warn('[codex-session-bridge] Background WSL session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundWslSessionBridgeTasks.set(taskKey, task)
  void task.finally(() => {
    if (backgroundWslSessionBridgeTasks.get(taskKey) === task) {
      backgroundWslSessionBridgeTasks.delete(taskKey)
    }
  })
  return task
}

/**
 * The WSL twin of the native account bridge (#22971): history lands only in a
 * home whose Codex index is complete, then Codex indexes it newest first.
 */
async function bridgeAndIndexWslCodexSessions(
  target: WslCodexSessionBridgeTarget,
  dependencies: WslBridgeDependencies
): Promise<void> {
  const paths = resolveWslCodexSessionBridgeLinuxPaths(target)
  if (!paths) {
    return
  }
  const buildInvocation = (_codexHomePath: string, timeoutMs: number) =>
    buildWslHealInvocation(target.distro, paths.managedHomePath, timeoutMs)
  const homeKey = normalizeRuntimePathForComparison(target.managedCodexHomePath)
  if (!homesWithCompleteIndex.has(homeKey)) {
    // Why: linking before Codex's first open makes that open index everything,
    // and every other Codex on the home gives up after 30s (#20669).
    const complete = await dependencies.openStateDb(target.managedCodexHomePath, {
      buildInvocation,
      timeoutMs: WSL_STATE_DB_OPEN_TIMEOUT_MS
    })
    if (!complete) {
      return
    }
    homesWithCompleteIndex.add(homeKey)
  }
  if (isCodexAccountSessionBridgeStopping()) {
    return
  }
  const summary = await syncWslCodexSessionsIntoManagedHome(target)
  const pendingThreads = new Map<string, string>()
  const markerByThreadId = new Map<string, string>()
  const markersWithoutThread: string[] = []
  for (const rolloutName of summary.pendingRollouts) {
    const rollout = parseCodexRolloutThreadId(rolloutName)
    if (rollout) {
      pendingThreads.set(rollout.threadId, rollout.rolloutStamp)
      markerByThreadId.set(rollout.threadId, rolloutName)
    } else {
      markersWithoutThread.push(rolloutName)
    }
  }
  if (markersWithoutThread.length > 0) {
    // Why: no thread id means thread/read can never settle it, so it would be reported forever.
    await clearIndexPendingMarkers(target.distro, paths, markersWithoutThread).catch(
      (error: unknown) => {
        console.warn('[codex-session-bridge] Could not clear WSL index markers:', error)
      }
    )
  }
  if (pendingThreads.size > 0 && !isCodexAccountSessionBridgeStopping()) {
    await dependencies.healPending(target.managedCodexHomePath, pendingThreads, {
      buildInvocation,
      shouldStop: isCodexAccountSessionBridgeStopping,
      afterBatch: (settled) =>
        clearSettledIndexPendingMarkers(target.distro, paths, settled, markerByThreadId)
    })
  }
  if (summary.bridgeFailed) {
    throw new Error(`WSL codex session bridge could not link every session for ${target.distro}`)
  }
}

/** Drops the markers of threads Codex indexed or no longer has; a failed read stays pending. */
async function clearSettledIndexPendingMarkers(
  distro: string,
  paths: WslCodexSessionBridgeLinuxPaths,
  settled: readonly CodexSettledThreadRead[],
  markerByThreadId: ReadonlyMap<string, string>
): Promise<void> {
  await clearIndexPendingMarkers(
    distro,
    paths,
    settled
      .filter(({ outcome }) => outcome !== 'failed')
      .flatMap(({ threadId }) => markerByThreadId.get(threadId) ?? [])
  )
}

async function clearIndexPendingMarkers(
  distro: string,
  paths: WslCodexSessionBridgeLinuxPaths,
  markers: readonly string[]
): Promise<void> {
  if (markers.length === 0) {
    return
  }
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: 'cd -- "$1" || exit 1\nshift\nrm -f -- "$@"',
    args: [paths.indexPendingRoot, ...markers],
    timeoutMs: WSL_SESSION_BRIDGE_TIMEOUT_MS
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Could not clear WSL Codex index markers (code ${result.code})`)
  }
}

export async function syncWslCodexSessionsIntoManagedHome(
  target: WslCodexSessionBridgeTarget
): Promise<WslCodexSessionBridgeSummary> {
  const paths = resolveWslCodexSessionBridgeLinuxPaths(target)
  if (!paths) {
    return emptySummary
  }

  const result = await runWslProcess({
    distro: target.distro,
    loginPath: 'none',
    script: buildWslCodexSessionBridgeShellCommand(paths),
    // Process substitution and `read -d` are bash-only; dash rejects both.
    shell: 'bash',
    timeoutMs: WSL_SESSION_BRIDGE_TIMEOUT_MS,
    maxOutputBytes: WSL_SESSION_BRIDGE_MAX_OUTPUT_BYTES
  })
  // Why: the summary is the script's last act, and a link failure still prints it so one bad
  // file cannot strand every marker; any other failure exits before it.
  const summary = result.timedOut ? null : parseWslSessionBridgeSummary(result.stdout)
  if (!summary) {
    throw Object.assign(
      new Error(`WSL codex session bridge failed for ${target.distro} (code ${result.code})`),
      { code: result.code, stderr: result.stderr, timedOut: result.timedOut }
    )
  }
  return { ...summary, bridgeFailed: result.code !== 0 }
}

export function resolveWslCodexSessionBridgeLinuxPaths(
  target: WslCodexSessionBridgeTarget
): WslCodexSessionBridgeLinuxPaths | null {
  const systemHomePath = getLinuxPathForWslDistro(target.systemCodexHomePath, target.distro)
  const managedHomePath = getLinuxPathForWslDistro(target.managedCodexHomePath, target.distro)
  if (!systemHomePath || !managedHomePath) {
    return null
  }

  return {
    systemSessionsRoot: joinLinuxPath(systemHomePath, 'sessions'),
    managedSessionsRoot: joinLinuxPath(managedHomePath, 'sessions'),
    managedHomePath,
    indexPendingRoot: joinLinuxPath(managedHomePath, WSL_INDEX_PENDING_DIR_NAME)
  }
}

function getWslSessionBridgeTaskKey(target: WslCodexSessionBridgeTarget): string {
  return [target.distro, target.systemCodexHomePath, target.managedCodexHomePath].join('\0')
}

function getLinuxPathForWslDistro(path: string, distro: string): string | null {
  const wslPath = parseWslUncPath(path)
  if (wslPath) {
    return wslDistroNamesMatch(wslPath.distro, distro) ? wslPath.linuxPath : null
  }
  return path.startsWith('/') ? path : null
}

function wslDistroNamesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function joinLinuxPath(basePath: string, ...segments: string[]): string {
  return pathPosix.join(basePath, ...segments)
}

function parseWslSessionBridgeSummary(stdout: string): WslCodexSessionBridgeSummary | null {
  // Why: login/profile scripts may write stdout before the bridge output.
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let parsed: unknown
  try {
    parsed = JSON.parse(lines.at(-1) ?? '')
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const summary = parsed as Record<string, unknown>
  if (typeof summary.scannedFiles !== 'number' || typeof summary.linkedFiles !== 'number') {
    return null
  }
  // Why: count every listed marker, not just Codex-shaped names, so one odd `rollout-*.jsonl`
  // cannot fail the count on every launch and strand the home's whole index heal.
  const markerLines = lines.slice(0, -1).filter((line) => line.startsWith('rollout-'))
  // Why: a clipped or noisy list would index the wrong set; its markers wait for the next launch.
  const pendingComplete =
    typeof summary.pendingFiles === 'number' && summary.pendingFiles === markerLines.length
  return {
    scannedFiles: summary.scannedFiles,
    linkedFiles: summary.linkedFiles,
    pendingRollouts: pendingComplete ? markerLines : [],
    bridgeFailed: false
  }
}

export const _internals = {
  reset: (): void => {
    backgroundWslSessionBridgeTasks.clear()
    homesWithCompleteIndex.clear()
  }
}
