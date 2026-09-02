import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { wslCodexRuntimeHomeForGuestHome } from '../pty/codex-home-wsl-env'
import { WSL_SESSION_BRIDGE_TIMEOUT_MS } from '../codex/wsl-codex-session-bridge-script'
import { runWslProcess } from '../wsl/wsl-runner'
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

export function startLegacyWslRuntimeAuthDrain(
  options: LegacyWslRuntimeAuthDrainOptions,
  startOptions: { throwOnFailure?: boolean } = {}
): Promise<void> {
  const key = options.distro.trim().toLowerCase()
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
      completedDistroKeys.add(key)
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
  try {
    assertSuccessfulDrainStep('apply', result)
  } catch {
    return recoverAfterFailedApply(options.distro, paths)
  }
  if (!deleteSource) {
    pendingSessionBridgeRouteByDistro.set(distroKey, sessionBridgeRoute)
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
  }
}
