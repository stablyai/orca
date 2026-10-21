/**
 * A supervised serve started from an AppImage keeps running the copy it unpacked (or the mount it
 * started from), so replacing the AppImage file never reached it, not even across a full service
 * restart. Before each start the supervisor checks that file; once it holds a new build, it execs
 * the new AppImage with its own arguments (same pid, so the service manager keeps tracking it).
 * That serve unpacks the new build and points the stable launcher at it, as any AppImage serve does.
 */
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
  /** Identity of the AppImage file the running build came from. */
  runningKey: string
}

export type AppImageBuildState = 'current' | 'settling' | 'superseded'

/** Null unless this supervisor runs a build unpacked from, or mounted from, a known AppImage. */
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
  /** Checked before the exec: a stop that arrived while probing must not start a new server. */
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
  // Why probe first: a host without FUSE cannot mount it, and an exec that fails there would
  // turn into a service restart loop instead of a server still running the old build.
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
  // Why: node mode moved the user's NODE_OPTIONS aside; the new launch moves it aside again.
  if (env.ORCA_NODE_OPTIONS) {
    next.NODE_OPTIONS = env.ORCA_NODE_OPTIONS
  }
  if (env.ORCA_NODE_REPL_EXTERNAL_MODULE) {
    next.NODE_REPL_EXTERNAL_MODULE = env.ORCA_NODE_REPL_EXTERNAL_MODULE
  }
  return next
}

/**
 * The new AppImage this profile's supervisor last exec'd, kept until a supervisor starts on it.
 * Why durable: a build that dies before its own crash brake would otherwise be exec'd on every
 * service restart of the old one, until the service manager's start limit disables the service.
 */
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
  // A supervisor running the attempted build proves it started; so does --force, by intent.
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
