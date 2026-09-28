import type { WslAccountExecutionContext } from '../wsl/wsl-account-execution-context'
import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { wslCodexRuntimeHomeForGuestHome } from '../pty/codex-home-wsl-env'
import { WSL_SESSION_BRIDGE_TIMEOUT_MS } from '../codex/wsl-codex-session-bridge-script'
import { runCapturedCodexWslProcess } from './captured-wsl-account-process'
import {
  captureDrainOptions,
  drainOwnerKey,
  type LegacyWslRuntimeAuthDrainOptions
} from './legacy-wsl-runtime-auth-drain-owner'
import { compareCodexAuthFreshness, codexAuthIsFresher } from './codex-auth-identity'
import {
  APPLY_LEGACY_AUTH_SCRIPT,
  FINALIZE_ABSENT_AUTH_SCRIPT,
  INSPECT_LEGACY_AUTH_SCRIPT,
  LEGACY_HOME_ABSENT_EXIT,
  LEGACY_HOME_STILL_PRESENT_EXIT,
  MARKER_PRESENT_EXIT,
  SOURCE_AUTH_ABSENT_EXIT
} from './legacy-wsl-runtime-auth-drain-scripts'
import { decodeWslBase64Payload } from './wsl-codex-auth-batch-reader'

const DRAIN_MARKER_NAME = 'direct-home-auth-drain-v1.json'

export type LegacyWslRuntimeAuthDestination = {
  authContents: string
  linuxHomePath: string
}

type LegacyWslRuntimeInspection = {
  authContents: string
  credentials: { kind: 'missing' } | { kind: 'present'; contents: string }
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
  options = captureDrainOptions(options)
  const key = drainOwnerKey(options)
  if (completedDistroKeys.has(key)) {
    return Promise.resolve()
  }
  // Coalesce launch/rate-limit callers while a drain is in flight. Queuing a
  // new pass for every poll can otherwise build an unbounded promise chain
  // while a legacy pane keeps the migration pending.
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
  options = captureDrainOptions(options)
  const distroKey = drainOwnerKey(options)
  const paths = resolveLegacyRuntimePaths(options.guestHomeLinuxPath)
  const inspection = await runCapturedCodexWslProcess(
    {
      distro: options.distro,
      loginPath: 'none',
      script: INSPECT_LEGACY_AUTH_SCRIPT,
      args: [paths.runtimeHome, paths.activeHome, paths.marker],
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024
    },
    options.execution
  )
  if (inspection.code === MARKER_PRESENT_EXIT) {
    return 'complete'
  }
  if (inspection.code === LEGACY_HOME_ABSENT_EXIT) {
    if (!options.legacyPanePresent) {
      return finalizeAbsentLegacyAuth(options.distro, paths, options.execution)
    }
    return 'pending'
  }
  if (inspection.code === SOURCE_AUTH_ABSENT_EXIT) {
    return 'pending'
  }
  assertSuccessfulDrainStep('inspect', inspection)

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
  const result = await runCapturedCodexWslProcess(
    {
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
        inspected.credentials.kind === 'present'
          ? sha256(inspected.credentials.contents)
          : 'missing',
        bridgeAllSessions ? 'full' : 'recent'
      ],
      timeoutMs: bridgeAllSessions ? WSL_SESSION_BRIDGE_TIMEOUT_MS : 5_000,
      maxOutputBytes: 16 * 1024
    },
    options.execution
  )
  try {
    assertSuccessfulDrainStep('apply', result)
  } catch {
    return recoverAfterFailedApply(options.distro, paths, options.execution)
  }
  if (!deleteSource) {
    rememberPendingRoute(distroKey, sessionBridgeRoute)
  }
  return deleteSource ? 'complete' : 'pending'
}

async function recoverAfterFailedApply(
  distro: string,
  paths: ReturnType<typeof resolveLegacyRuntimePaths>,
  execution?: WslAccountExecutionContext
): Promise<'complete' | 'pending'> {
  const recovery = await runCapturedCodexWslProcess(
    {
      distro,
      loginPath: 'none',
      script: INSPECT_LEGACY_AUTH_SCRIPT,
      args: [paths.runtimeHome, paths.activeHome, paths.marker],
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024
    },
    execution
  )
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
  paths: ReturnType<typeof resolveLegacyRuntimePaths>,
  execution?: WslAccountExecutionContext
): Promise<'complete' | 'pending'> {
  const result = await runCapturedCodexWslProcess(
    {
      distro,
      loginPath: 'none',
      script: FINALIZE_ABSENT_AUTH_SCRIPT,
      args: [paths.runtimeHome, paths.activeHome, paths.marker],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024
    },
    execution
  )
  if (result.code === LEGACY_HOME_STILL_PRESENT_EXIT) {
    return 'pending'
  }
  assertSuccessfulDrainStep('finalize', result)
  return 'complete'
}

function assertSuccessfulDrainStep(
  step: string,
  result: { code: number | null; stderr: string; timedOut: boolean }
): void {
  if (result.code === 0 && !result.timedOut) {
    return
  }
  const detail = result.stderr.trim()
  throw new Error(
    `Legacy WSL auth drain ${step} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${detail ? `: ${detail}` : ''}`
  )
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export const _internals = {
  applyLegacyAuthScript: APPLY_LEGACY_AUTH_SCRIPT,
  finalizeAbsentAuthScript: FINALIZE_ABSENT_AUTH_SCRIPT,
  inspectLegacyAuthScript: INSPECT_LEGACY_AUTH_SCRIPT,
  resetDrainQueue: (): void => {
    drainQueueByDistro.clear()
    completedDistroKeys.clear()
    pendingSessionBridgeRouteByDistro.clear()
  },
  drainDistroStateCountsForTests: (): { completed: number; pendingRoutes: number } => ({
    completed: completedDistroKeys.size,
    pendingRoutes: pendingSessionBridgeRouteByDistro.size
  })
}
