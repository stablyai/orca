/** AppImage swaps leave running copies stale; re-exec at the same PID to preserve service tracking. */
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  readAppImageSourceOfNamespace,
  resolveAppImageCacheKey,
  resolveAppImageGenerationOfExecutable
} from '../../shared/appimage-cache-identity'
import type { SupervisedAppImageUpdate } from './serve-supervised-service'
import { SERVE_SUPERVISOR_APP_ROOT_ENV } from './serve-supervisor-relocation'

/** A file this recently written may still be mid-copy; executing half an AppImage fails. */
export const APPIMAGE_SETTLE_MS = 2_000
const APPIMAGE_PROBE_TIMEOUT_MS = 60_000

export type AppImageBuildWatch = {
  appImagePath: string
  runningKey: string
}

export type AppImageBuildState = 'current' | 'settling' | 'superseded'

export function resolveAppImageBuildWatch(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): AppImageBuildWatch | null {
  if (platform !== 'linux') {
    return null
  }
  const generation = resolveAppImageGenerationOfExecutable(executable)
  if (generation) {
    const appImagePath = readAppImageSourceOfNamespace(
      generation.cacheRootPath,
      generation.namespaceKey
    )
    return appImagePath ? { appImagePath, runningKey: generation.generationKey } : null
  }
  const appImagePath = env.APPIMAGE
  const mounted =
    appImagePath &&
    isAbsolute(appImagePath) &&
    env.APPDIR &&
    resolve(env.APPDIR) === dirname(resolve(executable))
  const runningKey = mounted ? resolveAppImageCacheKey(appImagePath) : null
  return appImagePath && runningKey ? { appImagePath, runningKey } : null
}

/** A missing or unreadable file keeps the running build: only a present, settled new file counts. */
export function inspectAppImageBuild(
  watch: AppImageBuildWatch,
  now: number = Date.now()
): AppImageBuildState {
  const key = resolveAppImageCacheKey(watch.appImagePath)
  if (!key || key === watch.runningKey) {
    return 'current'
  }
  try {
    return now - statSync(watch.appImagePath).mtimeMs < APPIMAGE_SETTLE_MS
      ? 'settling'
      : 'superseded'
  } catch {
    return 'current'
  }
}

export type AppImageRestartDeps = {
  /** A stop received during the probe must prevent the exec. */
  isStopped: () => boolean
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void
  log: (line: string) => void
  /** Null when the AppImage runs here; otherwise why it does not. */
  probe?: (appImagePath: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  /** Records the build about to be exec'd; a throw keeps the running build. */
  beforeExec?: (candidateKey: string) => void
}

/** Never returns on success; otherwise returns why the running build stays. */
export async function restartFromNewAppImage(
  watch: AppImageBuildWatch,
  deps: AppImageRestartDeps
): Promise<string> {
  deps.log(`[serve] ${watch.appImagePath} holds a new Orca build; restarting from it.`)
  const env = appImageEnv(deps.env)
  // Probe FUSE support first to keep mount failures from causing a service restart loop.
  const refusal = await (deps.probe ?? probeAppImage)(watch.appImagePath, env)
  if (refusal) {
    return refusal
  }
  if (deps.isStopped()) {
    return 'the service is stopping'
  }
  const candidateKey = resolveAppImageCacheKey(watch.appImagePath)
  if (!candidateKey) {
    return 'the new AppImage is gone'
  }
  try {
    deps.beforeExec?.(candidateKey)
    deps.execve(watch.appImagePath, [watch.appImagePath, ...deps.argv.slice(2)], env)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'the new build could not be started'
}

async function probeAppImage(appImagePath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await runProcess({
      program: appImagePath,
      args: ['--version'],
      env,
      timeoutMs: APPIMAGE_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (result.code === 0) {
      return null
    }
    const detail = result.timedOut ? 'timed out' : result.stderr.trim().split('\n')[0]
    return `the new AppImage does not run here (${detail || `exit ${result.code}`})`
  } catch (error) {
    return `the new AppImage does not run here (${error instanceof Error ? error.message : String(error)})`
  }
}

/** The AppImage sets up its own mount and node mode; this build's state must not leak into it. */
function appImageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    SERVE_SUPERVISOR_APP_ROOT_ENV,
    'APPIMAGE',
    'APPDIR',
    'ARGV0',
    'OWD',
    'ORCA_CLI_LAUNCH_REDIRECTED'
  ]) {
    delete next[name]
  }
  // Restore NODE_OPTIONS before the new launcher moves it aside again.
  if (env.ORCA_NODE_OPTIONS) {
    next.NODE_OPTIONS = env.ORCA_NODE_OPTIONS
  }
  if (env.ORCA_NODE_REPL_EXTERNAL_MODULE) {
    next.NODE_REPL_EXTERNAL_MODULE = env.ORCA_NODE_REPL_EXTERNAL_MODULE
  }
  return next
}

/** Persist attempted builds to prevent service restart loops when they fail before their own brake. */
export function serveAppImageAttemptPath(userDataPath: string): string {
  return join(userDataPath, 'serve-supervisor-appimage-attempt.json')
}

function readAttemptedKey(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' &&
      parsed !== null &&
      'candidateKey' in parsed &&
      typeof parsed.candidateKey === 'string'
      ? parsed.candidateKey
      : null
  } catch {
    return null
  }
}

export type SupervisedAppImageUpdateDeps = Omit<AppImageRestartDeps, 'isStopped'> & {
  watch: AppImageBuildWatch
  attemptPath: string
  /** --force retries a build that failed to start before. */
  force: boolean
  now?: () => number
}

export function createSupervisedAppImageUpdate(
  deps: SupervisedAppImageUpdateDeps
): SupervisedAppImageUpdate {
  const { watch, attemptPath } = deps
  // Clear on successful startup of the attempted build or an explicit --force retry.
  if (deps.force || readAttemptedKey(attemptPath) === watch.runningKey) {
    rmSync(attemptPath, { force: true })
  }
  let reportedFailedAttempt = false
  return {
    inspect: () => {
      const state = inspectAppImageBuild(watch, deps.now?.())
      if (state !== 'superseded') {
        return state
      }
      if (readAttemptedKey(attemptPath) !== resolveAppImageCacheKey(watch.appImagePath)) {
        return state
      }
      if (!reportedFailedAttempt) {
        reportedFailedAttempt = true
        deps.log(
          `[serve] Keeping the running build: ${watch.appImagePath} was started once and did not come up. Replace it again, or run \`orca serve --supervise --force\` once to retry it.`
        )
      }
      return 'current'
    },
    restart: (isStopped) =>
      restartFromNewAppImage(watch, {
        ...deps,
        isStopped,
        beforeExec: (candidateKey) =>
          writeFileSync(attemptPath, JSON.stringify({ candidateKey }), { mode: 0o600 })
      })
  }
}

export function supervisedAppImageUpdate(
  executable: string,
  userDataPath: string,
  force: boolean
): SupervisedAppImageUpdate | null {
  const watch = resolveAppImageBuildWatch(executable)
  return watch
    ? createSupervisedAppImageUpdate({
        watch,
        attemptPath: serveAppImageAttemptPath(userDataPath),
        force,
        argv: process.argv,
        env: process.env,
        execve: (file, args, env) => {
          if (!process.execve) {
            throw new Error('this runtime cannot replace its own process')
          }
          process.execve(file, args, env)
        },
        log: (line) => process.stderr.write(`${line}\n`)
      })
    : null
}
