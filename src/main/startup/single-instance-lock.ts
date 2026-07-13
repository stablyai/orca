import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from 'electron'
import { writeStartupDiagnosticLine, type StartupDiagnosticSink } from './startup-diagnostics'

export const SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE =
  '[single-instance] Another Orca instance is already running for this userData profile; exiting this launch after requesting the existing window. If no Orca process is running, this may be an Electron/macOS single-instance lock failure.'
export const SINGLE_INSTANCE_LOCK_BYPASS_ENV = 'ORCA_BYPASS_SINGLE_INSTANCE_LOCK'
export const SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE =
  '[single-instance] ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1 is set; bypassing the packaged macOS single-instance lock for diagnostics. Do not use this with another Orca instance running for the same profile.'
export const SINGLE_INSTANCE_LOCK_FALLBACK_MESSAGE =
  '[single-instance] Electron reported the packaged macOS single-instance lock as unavailable, but no live Orca primary was found for this userData profile; continuing startup.'

type SingleInstancePrimaryEvidence = {
  kind: 'runtime-metadata' | 'singleton-lock'
  path: string
  detail: string
}

export type SingleInstanceLockFallbackDecision =
  | {
      shouldContinue: true
      reason: 'no-live-primary'
    }
  | {
      shouldContinue: false
      reason: 'unsupported-launch' | 'live-primary-found'
      evidence?: SingleInstancePrimaryEvidence
    }

type SingleInstanceLockFallbackDeps = {
  isPidAlive?: (pid: number) => boolean
}

/**
 * Why: Orca writes two canonical discovery files into `<userData>/`:
 * `orca-runtime.json` (RPC endpoint + authToken for the bundled CLI) and
 * `agent-hooks/endpoint.env` (hook port + token for cursor-agent/claude/codex
 * scripts). Without a single-instance lock, every AppImage/.app double-click
 * boots a fresh Electron main that clobbers both files. When the most recent
 * instance quits, metadata points at a dead pid and `orca status` reports
 * `stale_bootstrap` even though the original process is still running.
 *
 * This helper centralises the lock gate so it is testable in isolation and
 * so `src/main/index.ts` has one clean call site rather than two spread-out
 * Electron calls.
 *
 * Electron derives the lock identity from the current `userData` path, so
 * callers MUST invoke this AFTER `configureDevUserDataPath(is.dev)` — that
 * way dev (`orca-dev` userData) and packaged (`orca` userData) runs lock in
 * separate namespaces instead of serialising against each other.
 */
export function acquireSingleInstanceLock(app: App, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false
  }
  app.on('second-instance', onSecondInstance)
  return true
}

export function shouldBypassSingleInstanceLock(options: {
  env?: NodeJS.ProcessEnv
  isDev: boolean
  isServeMode: boolean
  platform?: NodeJS.Platform
}): boolean {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  return (
    platform === 'darwin' &&
    !options.isDev &&
    !options.isServeMode &&
    env[SINGLE_INSTANCE_LOCK_BYPASS_ENV] === '1'
  )
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    )
  }
}

function findRuntimeMetadataPrimary(
  userDataPath: string,
  isAlive: (pid: number) => boolean
): SingleInstancePrimaryEvidence | null {
  const metadataPath = join(userDataPath, 'orca-runtime.json')
  if (!existsSync(metadataPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as { pid?: unknown }
    const pid = typeof parsed.pid === 'number' ? parsed.pid : null
    if (pid !== null && isAlive(pid)) {
      return {
        kind: 'runtime-metadata',
        path: metadataPath,
        detail: `runtime pid ${pid} is alive`
      }
    }
  } catch {
    return null
  }

  return null
}

function parseSingletonLockPid(target: string): number | null {
  const match = /-(\d+)$/.exec(target)
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isInteger(pid) ? pid : null
}

function findSingletonLockPrimary(
  userDataPath: string,
  isAlive: (pid: number) => boolean
): SingleInstancePrimaryEvidence | null {
  const lockPath = join(userDataPath, 'SingletonLock')

  try {
    const stat = lstatSync(lockPath)
    if (!stat.isSymbolicLink()) {
      return {
        kind: 'singleton-lock',
        path: lockPath,
        detail: 'SingletonLock exists but is not a symlink'
      }
    }
    const target = readlinkSync(lockPath)
    const pid = parseSingletonLockPid(target)
    if (pid === null) {
      return {
        kind: 'singleton-lock',
        path: lockPath,
        detail: `SingletonLock target has no pid: ${target}`
      }
    }
    if (isAlive(pid)) {
      return {
        kind: 'singleton-lock',
        path: lockPath,
        detail: `SingletonLock pid ${pid} is alive`
      }
    }
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null
    }
    return {
      kind: 'singleton-lock',
      path: lockPath,
      detail: 'SingletonLock exists but could not be inspected'
    }
  }

  return null
}

export function decideSingleInstanceLockFallback(options: {
  appIsPackaged: boolean
  isDev: boolean
  isServeMode: boolean
  platform?: NodeJS.Platform
  userDataPath: string
  deps?: SingleInstanceLockFallbackDeps
}): SingleInstanceLockFallbackDecision {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' || !options.appIsPackaged || options.isDev || options.isServeMode) {
    return { shouldContinue: false, reason: 'unsupported-launch' }
  }

  const isAlive = options.deps?.isPidAlive ?? isPidAlive
  const evidence =
    findRuntimeMetadataPrimary(options.userDataPath, isAlive) ??
    findSingletonLockPrimary(options.userDataPath, isAlive)

  if (evidence) {
    return { shouldContinue: false, reason: 'live-primary-found', evidence }
  }

  return { shouldContinue: true, reason: 'no-live-primary' }
}

export function logSingleInstanceLockFailure(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_FAILURE_MESSAGE, write)
}

export function logSingleInstanceLockBypass(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_BYPASS_MESSAGE, write)
}

export function logSingleInstanceLockFallback(write?: StartupDiagnosticSink): void {
  writeStartupDiagnosticLine(SINGLE_INSTANCE_LOCK_FALLBACK_MESSAGE, write)
}
