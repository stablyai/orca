import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '../../shared/child-process/run-process'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../../shared/serve-update-handoff'
import {
  pinLaunchUserDataPath,
  pinServeUserDataPath,
  resolveLaunchUserDataPath
} from './launch-user-data-path'
import { getMacAppBundlePath } from './mac-app-update-bundle'
import { getPlatformUserDataPath } from './metadata'
import { isSameUserDataPath } from '../../shared/serve-user-data-path'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'
import { SERVE_RUNTIME_ELECTRON, SERVE_RUNTIME_ENV } from '../../shared/orcad-local-serve-selection'
import {
  resolveLocalServeRuntime,
  serveWithOrcad,
  type ServeOrcaAppArgs
} from './serve-orcad-launch'
import { waitForRecipeJson } from './serve-recipe-json'

const USER_NAMESPACE_PROBE_TIMEOUT_MS = 2_000

export function launchOrcaApp(): void {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnDetached(overrideCommand, [], { shell: true })
    return
  }

  // Why: `openOrca` waits on this profile's metadata, so the app must start on it too.
  const userDataPath = resolveLaunchUserDataPath()
  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    const pinned = pinLaunchUserDataPath(
      getExecutableAppArgs(overrideExecutable),
      stripElectronRunAsNode(process.env),
      userDataPath
    )
    spawnDetached(overrideExecutable, pinned.args, {
      ...getExecutableSpawnOptions(overrideExecutable),
      env: pinned.env
    })
    return
  }

  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    if (process.platform === 'darwin') {
      const appBundlePath = getMacAppBundlePath(process.execPath)
      if (appBundlePath) {
        // Why: launching the inner MacOS binary directly can trigger macOS app
        // launch failures and bypass normal bundle lifecycle. The public
        // packaged CLI should re-open the .app the same way Finder does.
        spawnDetached('open', getMacOpenArgs(appBundlePath, userDataPath), {
          env: stripElectronRunAsNode(process.env)
        })
        return
      }
    }

    const pinned = pinLaunchUserDataPath(
      getExecutableAppArgs(process.execPath),
      stripElectronRunAsNode(process.env),
      userDataPath
    )
    spawnDetached(process.execPath, pinned.args, { env: pinned.env })
    return
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Orca. Start Orca manually and try again.'
  )
}

/**
 * Plain `open` activates whichever instance already runs, which is the default profile's.
 * Why `-n` only off the default: `open` drops our env, and `--args` reach only a new instance.
 */
export function getMacOpenArgs(appBundlePath: string, userDataPath: string): string[] {
  if (isSameUserDataPath(userDataPath, getPlatformUserDataPath())) {
    return [appBundlePath]
  }
  return ['-n', appBundlePath, '--args', `--user-data-dir=${userDataPath}`]
}

function spawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
    ...options
  })
  // Why: detached launch errors are reported asynchronously after this function
  // returns; openOrca already reports the user-facing timeout if startup fails.
  child.once('error', () => {})
  child.unref()
}

export function serveOrcaApp(args: ServeOrcaAppArgs = {}): Promise<number> {
  const executable = resolveForegroundOrcaExecutable()
  if (args.recipeJson && !args.projectRoot) {
    throw new RuntimeClientError('invalid_argument', 'Recipe JSON output requires --project-root.')
  }
  // Why one value: the selector, orcad and Electron must all serve the profile the caller chose.
  const userDataPath = resolveLaunchUserDataPath()
  // Why synchronous on the opt-out: it must spawn Electron exactly as before, without asking.
  if (process.env[SERVE_RUNTIME_ENV] === SERVE_RUNTIME_ELECTRON) {
    return serveWithElectron(executable, args, userDataPath)
  }
  return serveWithSelectedRuntime(executable, args, userDataPath)
}

async function serveWithSelectedRuntime(
  executable: string,
  args: ServeOrcaAppArgs,
  userDataPath: string
): Promise<number> {
  const selection = await resolveLocalServeRuntime({
    executable,
    appRoot: resolveAppRoot(),
    userDataPath,
    usesMacUpdateHandoff: args.recipeJson !== true && getMacAppBundlePath(executable) !== null
  })
  if (selection.kind === 'orcad') {
    process.stderr.write(`[serve] running on orcad ${selection.version}\n`)
    return serveWithOrcad(selection, args, userDataPath, stripElectronRunAsNode(process.env))
  }
  if (selection.reason) {
    process.stderr.write(`[serve] using Electron serve: ${selection.reason}\n`)
  }
  return serveWithElectron(executable, args, userDataPath)
}

function serveWithElectron(
  executable: string,
  args: ServeOrcaAppArgs,
  userDataPath: string
): Promise<number> {
  const pinned = pinServeUserDataPath(
    getExecutableAppArgs(executable),
    stripElectronRunAsNode(process.env),
    userDataPath
  )
  const childArgs = pinned.args
  childArgs.push('--serve')
  if (args.json) {
    childArgs.push('--serve-json')
  }
  if (args.port) {
    childArgs.push('--serve-port', args.port)
  }
  if (args.pairingAddress) {
    childArgs.push('--serve-pairing-address', args.pairingAddress)
  }
  if (args.noPairing) {
    childArgs.push('--serve-no-pairing')
  }
  if (args.mobilePairing) {
    childArgs.push('--serve-mobile-pairing')
  }
  if (args.grantDesktopControl) {
    childArgs.push('--serve-grant-desktop-control')
  }
  if (args.recipeJson && args.projectRoot) {
    childArgs.push('--serve-recipe-json', '--serve-project-root', args.projectRoot)
  }

  const handoffPath =
    args.recipeJson !== true && getMacAppBundlePath(executable)
      ? getServeUpdateHandoffPath(userDataPath)
      : null
  const childEnv = pinned.env
  if (handoffPath) {
    childEnv[SERVE_UPDATE_HANDOFF_PATH_ENV] = handoffPath
  }
  const spawnOptions: SpawnOptions = {
    detached: args.recipeJson === true,
    cwd: resolveAppRoot(),
    stdio:
      args.recipeJson === true
        ? ['ignore', 'pipe', 'inherit']
        : handoffPath
          ? ['inherit', 'inherit', 'inherit', 'ipc']
          : 'inherit',
    ...getExecutableSpawnOptions(executable),
    env: childEnv
  }
  const interruptedHandoff = handoffPath ? readServeUpdateHandoffSync(handoffPath) : null
  if (interruptedHandoff?.phase === 'install-requested') {
    // Why: the node-mode CLI is not an NSRunningApplication, so it can retain launchd ownership while ShipIt swaps the app.
    return resumeInterruptedServeUpdate({
      executable,
      childArgs,
      spawnOptions,
      spawnChild: spawnProcess,
      handoffPath: handoffPath!,
      handoff: interruptedHandoff
    })
  }
  const child = spawnProcess(executable, childArgs, spawnOptions)

  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    executable,
    childArgs,
    spawnOptions,
    spawnChild: spawnProcess,
    child,
    handoffPath,
    expectedHandoff: null
  })
}

export function getExecutableAppArgs(executable: string): string[] {
  const args = process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1' ? [resolveAppRoot()] : []
  if (shouldDisableExtractedAppImageSandbox(executable)) {
    args.push('--no-sandbox')
  }
  return args
}

function shouldDisableExtractedAppImageSandbox(executable: string): boolean {
  if (process.platform !== 'linux' || !existsSync(join(dirname(executable), 'AppRun'))) {
    return false
  }
  // An extracted AppImage has no root-owned setuid sandbox; mirror AppRun's userns fallback.
  if (process.getuid?.() === 0) {
    return true
  }
  try {
    return (
      runProcessSync({
        program: 'unshare',
        args: ['-Ur', 'true'],
        stdio: 'ignore',
        timeoutMs: USER_NAMESPACE_PROBE_TIMEOUT_MS
      }).code !== 0
    )
  } catch {
    return true
  }
}

function getExecutableSpawnOptions(executable: string): Pick<SpawnOptions, 'shell'> {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) ? { shell: true } : {}
}

export function resolveAppRoot(): string {
  // Why: dev-mode resource resolution in the Electron child may consult
  // process.cwd(). Pin it to the app root so `orca serve` behaves the same
  // regardless of the shell directory it was launched from.
  return resolve(__dirname, '../../..')
}

export function resolveForegroundOrcaExecutable(): string {
  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return overrideExecutable
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    return process.execPath
  }
  throw new RuntimeClientError(
    'runtime_serve_failed',
    'Could not determine how to start Orca server. Set ORCA_APP_EXECUTABLE to the Orca executable.'
  )
}

export function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}
