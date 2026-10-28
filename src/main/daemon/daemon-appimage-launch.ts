// Launch APPIMAGE to give the daemon its own FUSE mount; the window's mount dies with its runtime.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import type { DurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { envWithoutAppImageRuntime } from '../pty/appimage-terminal-env'

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

export function isFuseMountPoint(mountInfo: string, mountPoint: string): boolean {
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

/** Null outside FUSE AppImages: extract-and-run launches may share an extraction directory. */
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
  // Defer synchronous identity reads until cheap path checks pass.
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

/** Use APPIMAGE plus the relative entry: random mount paths cannot identify surviving daemons. */
export function appImageDaemonIdentityPath(launch: AppImageDaemonLaunch): string {
  return join(launch.appImagePath, launch.entryPathInAppDir)
}

function buildBootstrap(launch: AppImageDaemonLaunch): string {
  const version = JSON.stringify(launch.appVersion)
  return [
    `const {join}=require('path')`,
    `const v=require(join(process.env.APPDIR,${JSON.stringify(launch.appPathInAppDir)},'package.json')).version`,
    // The file at APPIMAGE may already contain an updated release.
    `if(v!==${version}){console.error('[daemon] AppImage is '+v+', expected '+${version});process.exit(1)}`,
    `const e=join(process.env.APPDIR,${JSON.stringify(launch.entryPathInAppDir)})`,
    `process.argv.splice(1,0,e)`,
    `require(e)`
  ].join(';')
}

export function buildAppImageDaemonCommand(
  launch: AppImageDaemonLaunch,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv
): DurableDaemonScopeCommand {
  // AppRun prepends the new mount but retains old PATH and loader entries unless scrubbed.
  const childEnv = envWithoutAppImageRuntime(env)
  return {
    command: launch.appImagePath,
    // Suppress AppRun's injected Node-incompatible flag by placing --no-sandbox after the script.
    args: ['-e', buildBootstrap(launch), '--', ...scriptArgs, '--no-sandbox'],
    env: childEnv
  }
}
