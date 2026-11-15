import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { wslCodexRuntimeHomeForGuestHome } from '../../pty/shell-startup/codex-home-wsl-env'
import { WSL_SESSION_BRIDGE_TIMEOUT_MS } from '../../codex/history/bridges/wsl-codex-session-bridge-script'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import {
  describeWslProcessFailure,
  isWslHostFailureExitCode
} from '../../wsl/execution/wsl-process-failure'
import { compareCodexAuthFreshness, codexAuthIsFresher } from '../credentials/codex-auth-identity'
import {
  APPLY_LEGACY_AUTH_SCRIPT,
  INSPECT_LEGACY_AUTH_SCRIPT
} from './legacy-wsl-runtime-auth-drain-scripts'
import { FINALIZE_ABSENT_AUTH_SCRIPT } from './legacy-wsl-runtime-auth-finalize-script'
import {
  LEGACY_HOME_ABSENT_EXIT,
  LEGACY_HOME_STILL_PRESENT_EXIT,
  MARKER_PRESENT_EXIT,
  SOURCE_AUTH_ABSENT_EXIT
} from './legacy-wsl-runtime-auth-drain-exit-codes'
import { decodeWslBase64Payload } from '../runtime-home/wsl/wsl-codex-auth-batch-reader'

const DRAIN_MARKER_NAME = 'direct-home-auth-drain-v1.json'

export type LegacyWslRuntimeAuthDestination = {
  authContents: string
  linuxHomePath: string
}

type LegacyWslRuntimeInspection = {
  authContents: string
  credentials: { kind: 'missing' } | { kind: 'present'; contents: string }
}

type LegacyWslRuntimeAuthDrainOptions = {
  distro: string
  guestHomeLinuxPath: string
  legacyPanePresent: boolean
  resolveDestination: (
    runtimeAuthContents: string
  ) => LegacyWslRuntimeAuthDestination | null | Promise<LegacyWslRuntimeAuthDestination | null>
}

const drainQueueByDistro = new Map<string, Promise<void>>()
const completedDistroKeys = new Set<string>()
const pendingSessionBridgeRouteByDistro = new Map<string, string>()
const MAX_DRAIN_DISTRO_ENTRIES = 128

function rememberCompletedDistro(key: string): void {
  completedDistroKeys.delete(key)
  completedDistroKeys.add(key)
  while (completedDistroKeys.size > MAX_DRAIN_DISTRO_ENTRIES) {
    const oldest = completedDistroKeys.values().next().value
    if (oldest === undefined) {
      break
    }
    completedDistroKeys.delete(oldest)
  }
}

function rememberPendingRoute(key: string, route: string): void {
  pendingSessionBridgeRouteByDistro.delete(key)
  pendingSessionBridgeRouteByDistro.set(key, route)
  while (pendingSessionBridgeRouteByDistro.size > MAX_DRAIN_DISTRO_ENTRIES) {
    const oldest = pendingSessionBridgeRouteByDistro.keys().next().value
    if (oldest === undefined) {
      break
    }
    pendingSessionBridgeRouteByDistro.delete(oldest)
  }
}

export function startLegacyWslRuntimeAuthDrain(
  options: LegacyWslRuntimeAuthDrainOptions,
  startOptions: { throwOnFailure?: boolean } = {}
): Promise<void> {
  const key = options.distro.trim().toLowerCase()
  if (completedDistroKeys.has(key)) {
    return Promise.resolve()
  }
  // Coalesce callers so polling a pending migration cannot build an unbounded promise chain.
  const inFlight = drainQueueByDistro.get(key)
  if (inFlight) {
    return startOptions.throwOnFailure ? inFlight : logDrainFailure(inFlight)
  }
  const next = drainLegacyWslRuntimeAuth(options).then((status) => {
    if (status === 'complete') {
      rememberCompletedDistro(key)
    }
  })
  drainQueueByDistro.set(key, next)
  const clearQueue = (): void => {
    if (drainQueueByDistro.get(key) === next) {
      drainQueueByDistro.delete(key)
    }
  }
  void next.then(clearQueue, clearQueue)
  return startOptions.throwOnFailure ? next : logDrainFailure(next)
}

function logDrainFailure(task: Promise<void>): Promise<void> {
  return task.catch((error) => {
    console.warn('[codex-wsl-auth-drain] Failed to drain legacy runtime auth:', error)
  })
}

export async function drainLegacyWslRuntimeAuth(
  options: LegacyWslRuntimeAuthDrainOptions
): Promise<'complete' | 'pending'> {
  const distroKey = options.distro.trim().toLowerCase()
  const paths = resolveLegacyRuntimePaths(options.guestHomeLinuxPath)
  const inspection = await runWslProcess({
    distro: options.distro,
    loginPath: 'none',
    script: INSPECT_LEGACY_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (inspection.code === MARKER_PRESENT_EXIT) {
    return 'complete'
  }
  if (inspection.code === LEGACY_HOME_ABSENT_EXIT) {
    if (!options.legacyPanePresent) {
      return finalizeAbsentLegacyAuth(options.distro, paths)
    }
    return 'pending'
  }
  if (inspection.code === SOURCE_AUTH_ABSENT_EXIT) {
    return 'pending'
  }
  if (!assertSuccessfulDrainStep('inspect', inspection)) {
    return 'pending'
  }

  const inspected = parseLegacyRuntimeInspection(inspection.stdout)
  if (!inspected) {
    return 'pending'
  }
  const destination = await options.resolveDestination(inspected.authContents)
  if (!destination) {
    return 'pending'
  }
  const freshness = compareCodexAuthFreshness(inspected.authContents, destination.authContents)
  const promoteAuth =
    freshness !== null && codexAuthIsFresher(inspected.authContents, destination.authContents)
  const deleteSource = !options.legacyPanePresent && freshness !== null
  const sessionBridgeRoute = [
    paths.runtimeHome,
    destination.linuxHomePath,
    options.legacyPanePresent ? 'retained' : 'released'
  ].join('\0')
  const bridgeAllSessions =
    deleteSource || pendingSessionBridgeRouteByDistro.get(distroKey) !== sessionBridgeRoute
  const result = await runWslProcess({
    distro: options.distro,
    loginPath: 'none',
    script: APPLY_LEGACY_AUTH_SCRIPT,
    args: [
      paths.runtimeHome,
      paths.activeHome,
      paths.marker,
      destination.linuxHomePath,
      sha256(inspected.authContents),
      sha256(destination.authContents),
      promoteAuth ? '1' : '0',
      deleteSource ? '1' : '0',
      inspected.credentials.kind === 'present' ? sha256(inspected.credentials.contents) : 'missing',
      bridgeAllSessions ? 'full' : 'recent'
    ],
    timeoutMs: bridgeAllSessions ? WSL_SESSION_BRIDGE_TIMEOUT_MS : 5_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0 || result.timedOut) {
    if (result.timedOut || isWslHostFailureExitCode(result.code)) {
      // Environmental failure says nothing about migration state; keep the diagnostic and retry (#42641).
      console.warn(
        `[codex-wsl-auth-drain] apply step could not reach WSL, will retry: ${describeWslProcessFailure(result)}`
      )
      return recoverAfterFailedApply(options.distro, paths)
    }
    const recovered = await recoverAfterFailedApply(options.distro, paths)
    // Exits 37/38 are hash drift since inspection — the next drain re-reads the new state. Any
    // other guest exit is deterministic: with migration state unchanged it would fail on every
    // launch, so surface it instead of retrying silently.
    if (recovered === 'pending' && result.code !== 37 && result.code !== 38) {
      const detail = result.stderr.trim()
      throw new Error(
        `Legacy WSL auth drain apply failed (exit ${result.code})${detail ? `: ${detail}` : ''}`
      )
    }
    return recovered
  }
  if (!deleteSource) {
    rememberPendingRoute(distroKey, sessionBridgeRoute)
  }
  return deleteSource ? 'complete' : 'pending'
}

async function recoverAfterFailedApply(
  distro: string,
  paths: ReturnType<typeof resolveLegacyRuntimePaths>
): Promise<'complete' | 'pending'> {
  const recovery = await runWslProcess({
    distro,
    loginPath: 'none',
    script: INSPECT_LEGACY_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (recovery.code === MARKER_PRESENT_EXIT) {
    return 'complete'
  }
  if (
    !recovery.timedOut &&
    (recovery.code === 0 ||
      recovery.code === SOURCE_AUTH_ABSENT_EXIT ||
      recovery.code === LEGACY_HOME_ABSENT_EXIT)
  ) {
    return 'pending'
  }
  // Throws on guest-side defects; wsl.exe host failures here only delay the retry (#42641).
  assertSuccessfulDrainStep('recover', recovery)
  return 'pending'
}

function parseLegacyRuntimeInspection(stdout: string): LegacyWslRuntimeInspection | null {
  const [authBase64, credentialsKind, credentialsBase64] = stdout.split('\n')
  const authContents = decodeWslBase64Payload(authBase64 ?? '')
  if (authContents === null) {
    return null
  }
  if (credentialsKind === 'missing') {
    return { authContents, credentials: { kind: 'missing' } }
  }
  if (credentialsKind !== 'present') {
    return null
  }
  const credentialsContents = decodeWslBase64Payload(credentialsBase64 ?? '')
  if (!credentialsContents || !isJsonObject(credentialsContents)) {
    return null
  }
  return { authContents, credentials: { kind: 'present', contents: credentialsContents } }
}

function isJsonObject(contents: string): boolean {
  try {
    const value = JSON.parse(contents) as unknown
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function resolveLegacyRuntimePaths(guestHomeLinuxPath: string): {
  activeHome: string
  marker: string
  runtimeHome: string
} {
  const runtimeHome = wslCodexRuntimeHomeForGuestHome(guestHomeLinuxPath)
  const runtimeRoot = pathPosix.dirname(runtimeHome)
  return {
    activeHome: pathPosix.join(runtimeRoot, 'active', 'wsl', 'home'),
    marker: pathPosix.join(runtimeRoot, DRAIN_MARKER_NAME),
    runtimeHome
  }
}

async function finalizeAbsentLegacyAuth(
  distro: string,
  paths: ReturnType<typeof resolveLegacyRuntimePaths>
): Promise<'complete' | 'pending'> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: FINALIZE_ABSENT_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code === LEGACY_HOME_STILL_PRESENT_EXIT) {
    return 'pending'
  }
  if (!assertSuccessfulDrainStep('finalize', result)) {
    return 'pending'
  }
  return 'complete'
}

/**
 * Throws for guest-side migration defects. Returns false when wsl.exe itself failed (exit
 * 4294967295, its diagnostic on stdout, per #42641) or timed out: an environment problem says
 * nothing about migration state, so the drain retries on the next launch instead of blocking
 * this one — a genuinely broken WSL surfaces through the launch spawn's own error.
 */
function assertSuccessfulDrainStep(
  step: string,
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }
): boolean {
  if (result.code === 0 && !result.timedOut) {
    return true
  }
  if (result.timedOut || isWslHostFailureExitCode(result.code)) {
    console.warn(
      `[codex-wsl-auth-drain] ${step} step could not reach WSL, will retry: ${describeWslProcessFailure(result)}`
    )
    return false
  }
  const detail = result.stderr.trim()
  throw new Error(
    `Legacy WSL auth drain ${step} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`
  )
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}
