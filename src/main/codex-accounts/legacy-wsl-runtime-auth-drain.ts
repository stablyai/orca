import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { runWslProcess } from '../wsl/wsl-runner'
import { compareCodexAuthFreshness, codexAuthIsFresher } from './codex-auth-identity'
import {
  APPLY_LEGACY_AUTH_SCRIPT,
  FINALIZE_ABSENT_AUTH_SCRIPT,
  INSPECT_LEGACY_AUTH_SCRIPT,
  MARKER_PRESENT_EXIT,
  SOURCE_AUTH_ABSENT_EXIT
} from './legacy-wsl-runtime-auth-drain-scripts'

const DRAIN_MARKER_NAME = 'direct-home-auth-drain-v1.json'

export type LegacyWslRuntimeAuthDestination = { authContents: string; linuxHomePath: string }
type Inspection = {
  authContents: string
  credentials: { kind: 'missing' } | { kind: 'present'; contents: string }
}
export type LegacyWslRuntimeAuthDrainOptions = {
  distro: string
  guestHomeLinuxPath: string
  legacyPanePresent: boolean
  resolveDestination: (
    authContents: string
  ) => LegacyWslRuntimeAuthDestination | null | Promise<LegacyWslRuntimeAuthDestination | null>
}

const inFlight = new Map<string, Promise<void>>()
const complete = new Set<string>()

export function startLegacyWslRuntimeAuthDrain(options: LegacyWslRuntimeAuthDrainOptions): void {
  const key = `${options.distro.trim().toLowerCase()}\0${pathPosix.normalize(options.guestHomeLinuxPath)}`
  if (complete.has(key) || inFlight.has(key)) {
    return
  }
  const task = drainLegacyWslRuntimeAuth(options)
    .then((status) => {
      if (status === 'complete') {
        complete.add(key)
      }
    })
    .catch((error) =>
      console.warn('[codex-wsl-auth-drain] Failed to drain legacy runtime auth:', error)
    )
  inFlight.set(key, task)
  void task.finally(() => {
    if (inFlight.get(key) === task) {
      inFlight.delete(key)
    }
  })
}

export async function drainLegacyWslRuntimeAuth(
  options: LegacyWslRuntimeAuthDrainOptions
): Promise<'complete' | 'pending'> {
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
  if (inspection.code === SOURCE_AUTH_ABSENT_EXIT) {
    return options.legacyPanePresent ? 'pending' : finalizeAbsentLegacyAuth(options.distro, paths)
  }
  assertSuccessfulDrainStep('inspect', inspection)
  const inspected = parseInspection(inspection.stdout)
  if (!inspected) {
    return 'pending'
  }
  const destination = await options.resolveDestination(inspected.authContents)
  if (!destination) {
    return 'pending'
  }
  const freshness = compareCodexAuthFreshness(inspected.authContents, destination.authContents)
  if (freshness === null) {
    return 'pending'
  }
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
      codexAuthIsFresher(inspected.authContents, destination.authContents) ? '1' : '0',
      options.legacyPanePresent ? '0' : '1',
      inspected.credentials.kind === 'present' ? sha256(inspected.credentials.contents) : 'missing'
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  assertSuccessfulDrainStep('apply', result)
  return options.legacyPanePresent ? 'pending' : 'complete'
}

function parseInspection(stdout: string): Inspection | null {
  const [authBase64, kind, credentialsBase64] = stdout.split('\n')
  const authContents = decode(authBase64 ?? '')
  if (authContents === null) {
    return null
  }
  if (kind === 'missing') {
    return { authContents, credentials: { kind: 'missing' } }
  }
  if (kind !== 'present') {
    return null
  }
  const contents = decode(credentialsBase64 ?? '')
  if (contents === null || !isJsonObject(contents)) {
    return null
  }
  return { authContents, credentials: { kind: 'present', contents } }
}

function decode(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return Buffer.from(decoded).toString('base64') === value.replace(/\n/g, '') ? decoded : null
  } catch {
    return null
  }
}
function isJsonObject(contents: string): boolean {
  try {
    const value = JSON.parse(contents) as unknown
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}
function resolveLegacyRuntimePaths(guestHomeLinuxPath: string) {
  const runtimeHome = pathPosix.join(guestHomeLinuxPath, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS)
  const root = pathPosix.dirname(runtimeHome)
  return {
    runtimeHome,
    activeHome: pathPosix.join(root, 'active', 'wsl', 'home'),
    marker: pathPosix.join(root, DRAIN_MARKER_NAME)
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
  throw new Error(
    `Legacy WSL auth drain ${step} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
  )
}
function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export const _internals = {
  applyLegacyAuthScript: APPLY_LEGACY_AUTH_SCRIPT,
  inspectLegacyAuthScript: INSPECT_LEGACY_AUTH_SCRIPT,
  resetDrainQueue: (): void => {
    inFlight.clear()
    complete.clear()
  }
}
