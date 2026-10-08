/**
 * Launching the daemon through the AppImage file itself (#18200).
 *
 * Run from `$APPDIR/orca-ide`, the daemon executes out of the parent's FUSE mount, which the
 * AppImage runtime tears down when the window process exits or the login session ends; the
 * surviving daemon then SIGBUSes on its next cold page. Exec'ing `$APPIMAGE` instead gives the
 * daemon its own runtime and mount, created inside the daemon's own scope and released when the
 * daemon exits. The new mount's path is unknown to the parent, so a `-e` bootstrap resolves the
 * entry against the `APPDIR` the child runtime exports.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import type { DurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'

export type AppImageDaemonLaunch = {
  appImagePath: string
  /** Entry and app.asar paths relative to APPDIR, resolved again inside the child's own mount. */
  entryPathInAppDir: string
  appPathInAppDir: string
  appVersion: string
}

type AppImageDaemonLaunchInput = {
  entryPath: string
  appPath: string
  appVersion: string
  environment?: NodeJS.ProcessEnv
  readMountInfo?: () => string
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

function isFuseMountPoint(mountInfo: string, mountPoint: string): boolean {
  return mountInfo.split('\n').some((line) => {
    const [mountFields, fsFields] = line.split(' - ')
    const point = mountFields?.split(' ')[4]
    return (
      point !== undefined &&
      decodeMountInfoPath(point) === mountPoint &&
      fsFields?.startsWith('fuse') === true
    )
  })
}

/** Null keeps the in-mount launch: not a validated AppImage, or the payload is not on a FUSE
 *  mount (extract-and-run, where a second run would share and delete the same extraction dir). */
export function resolveAppImageDaemonLaunch({
  entryPath,
  appPath,
  appVersion,
  environment = process.env,
  readMountInfo = () => readFileSync('/proc/self/mountinfo', 'utf8')
}: AppImageDaemonLaunchInput): AppImageDaemonLaunch | null {
  const appDir = environment.APPDIR
  if (!appDir) {
    return null
  }
  const entryPathInAppDir = relativePathInsideRoot(appDir, entryPath)
  const appPathInAppDir = relativePathInsideRoot(appDir, appPath)
  if (!entryPathInAppDir || !appPathInAppDir) {
    return null
  }
  // Why after the path checks: identity validation does several synchronous file reads.
  const identity = resolveAppImageRuntimeIdentity({ environment })
  if (!identity) {
    return null
  }
  try {
    if (!isFuseMountPoint(readMountInfo(), appDir)) {
      return null
    }
  } catch {
    return null
  }
  return { appImagePath: identity.appImagePath, entryPathInAppDir, appPathInAppDir, appVersion }
}

/**
 * The `--entry-path` identity an own-mount daemon records. Why not the mount path: each launch
 * mounts at a fresh random dir, so the next window could never match a surviving daemon. A new
 * release at the same `$APPIMAGE` still gets replaced via the recorded `--app-version`.
 */
export function appImageDaemonIdentityPath(launch: AppImageDaemonLaunch): string {
  return join(launch.appImagePath, launch.entryPathInAppDir)
}

function buildBootstrap(launch: AppImageDaemonLaunch): string {
  const version = JSON.stringify(launch.appVersion)
  return [
    `const {join}=require('path')`,
    `const v=require(join(process.env.APPDIR,${JSON.stringify(launch.appPathInAppDir)},'package.json')).version`,
    // Why: the file at $APPIMAGE may already be a different release (manual replace, updater).
    `if(v!==${version}){console.error('[daemon] AppImage is '+v+', expected '+${version});process.exit(1)}`,
    `const e=join(process.env.APPDIR,${JSON.stringify(launch.entryPathInAppDir)})`,
    `process.argv.splice(1,0,e)`,
    `require(e)`
  ].join(';')
}

/** The program/args/env replacing `execPath entry ...scriptArgs` for an AppImage launch. */
export function buildAppImageDaemonCommand(
  launch: AppImageDaemonLaunch,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv
): DurableDaemonScopeCommand {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value
    }
  }
  // Why: AppRun prepends the new mount but keeps inherited entries, so drop the parent's mount.
  removeAppImageRuntimeEnv(childEnv)
  return {
    command: launch.appImagePath,
    // Why trailing --no-sandbox: without it AppRun injects one before the script, which Node rejects.
    args: ['-e', buildBootstrap(launch), '--', ...scriptArgs, '--no-sandbox'],
    env: childEnv
  }
}
