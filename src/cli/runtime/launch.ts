import { spawn, type SpawnOptions } from 'node:child_process'
import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../../shared/serve-update-handoff'
import {
  pinLaunchUserDataPath,
  pinServeUserDataPath,
  resolveLaunchUserDataPath
} from './launch-user-data-path'
import { foregroundServeIsolatedProfileSwitches } from '../../shared/electron-isolated-profile-switches'
import { headlessServeOzonePlatformSwitches } from '../../shared/headless-serve-ozone-platform'
import { ELECTRON_NO_SANDBOX_REQUEST_ENV } from '../../shared/electron-no-sandbox-request'
import { needsElectronNoSandbox } from './electron-sandbox-switch'
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
import { findBundledWebClientRoot } from '../../shared/bundled-web-client-root'
import { resolveLocalServeRuntime, serveWithOrcad } from './serve-orcad-launch'
import { serveOptionArgs, type ServeOrcaAppArgs } from '../../shared/orcad-serve-argv'
import { waitForRecipeJson } from './serve-recipe-json'
import {
  preflightElectronServe,
  recordElectronServeStartupAbort,
  refuseIfProfileServed
} from './serve-electron-preflight'
import { MacServeStartupAbortError } from './serve-signal-exit-diagnostic'
import { superviseServeService } from './serve-supervised-service'
import { reexecThisServeUnderInitReaper } from './serve-pid1-init-reaper'
import { supervisedAppImageUpdate } from './serve-appimage-update'
import {
  relocateThisServeSupervisor,
  SERVE_SUPERVISOR_APP_ROOT_ENV
} from './serve-supervisor-relocation'
import { serverOnlyServeMessage } from './serve-app-launcher'
import { isSupervisedSpawnHeld } from './serve-supervised-stop'
import { openServeBundlePark } from './serve-bundle-park'
import {
  redactingSpawn,
  shouldRedactSupervisedStdout,
  type ServeSpawnChild
} from './serve-pairing-redaction'

const STARTUP_ABORT_MS = 30_000

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
  const child = spawn(command, args, {
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
  // Why first: as a container or PrivatePIDs init, nothing would reap orphaned descendants.
  reexecThisServeUnderInitReaper()
  const executable = resolveForegroundOrcaExecutable()
  // Why one value: the selector, orcad and Electron must all serve the profile the caller chose.
  const userDataPath = resolveLaunchUserDataPath()
  if (args.supervise) {
    // Why: a successful relocation replaces this process and never resolves.
    return relocateThisServeSupervisor(resolveAppRoot(), userDataPath).then(() => {
      let attempt = 0
      return superviseServeService({
        userDataPath,
        executable,
        appRoot: resolveAppRoot(),
        force: args.force === true,
        park: openServeBundlePark({ executable }),
        appImageUpdate: supervisedAppImageUpdate(executable, userDataPath, args.force === true),
        // Why first only: --force overrides a remembered abort once; the brake owns later attempts.
        runOnce: () =>
          serveOnce(
            executable,
            { ...args, force: args.force === true && attempt++ === 0 },
            userDataPath
          )
      })
    })
  }
  return serveOnce(executable, args, userDataPath)
}

function serveOnce(
  executable: string,
  args: ServeOrcaAppArgs,
  userDataPath: string
): Promise<number> {
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
    // Why only supervised: orcad refuses a held profile as a configuration fault (exit 78), which
    // the brake would count; exit 3 here lets the supervisor wait for the other Orca instead.
    const refusal = args.supervise ? await refuseIfProfileServed(args, userDataPath) : null
    if (refusal !== null) {
      return refusal
    }
    process.stderr.write(`[serve] running on orcad ${selection.version}\n`)
    return serveWithOrcad(
      selection,
      args,
      userDataPath,
      stripElectronRunAsNode(process.env),
      findBundledWebClientRoot(resolveAppRoot())
    )
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
  const preflight = preflightElectronServe(args, userDataPath)
  if (preflight === null) {
    return spawnElectronServe(executable, args, userDataPath)
  }
  return Promise.resolve(preflight).then(
    (refusal) => refusal ?? spawnElectronServe(executable, args, userDataPath)
  )
}

function spawnElectronServe(
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
  childArgs.push('--serve', ...serveOptionArgs(args, '--serve-'))
  // Why: the isolated profile has no login keychain, and the probe that discovers this blocks the
  // foreground process on the Keychain authorization prompt before it advertises readiness (#25453).
  childArgs.push(...foregroundServeIsolatedProfileSwitches())
  childArgs.push(...headlessServeOzonePlatformSwitches(process.platform))
  const handoffPath =
    args.recipeJson !== true && getMacAppBundlePath(executable)
      ? getServeUpdateHandoffPath(userDataPath)
      : null
  const childEnv = pinned.env
  if (handoffPath) {
    childEnv[SERVE_UPDATE_HANDOFF_PATH_ENV] = handoffPath
  }
  // Why process-host: it encodes a Windows `.cmd`/`.bat` executable's arguments instead of a raw shell.
  const spec: ProcessSpec = {
    program: executable,
    args: childArgs,
    detached: args.recipeJson === true,
    cwd: resolveAppRoot(),
    stdio:
      args.recipeJson === true
        ? ['ignore', 'pipe', 'inherit']
        : handoffPath
          ? ['inherit', 'inherit', 'inherit', 'ipc']
          : 'inherit',
    env: childEnv
  }
  const spawnServeChild: ServeSpawnChild = shouldRedactSupervisedStdout(args.supervise === true)
    ? redactingSpawn(spawnProcess)
    : spawnProcess
  const interruptedHandoff = handoffPath ? readServeUpdateHandoffSync(handoffPath) : null
  if (interruptedHandoff?.phase === 'install-requested') {
    // Why: the node-mode CLI is not an NSRunningApplication, so it can retain launchd ownership while ShipIt swaps the app.
    return resumeInterruptedServeUpdate({
      spec,
      spawnChild: spawnServeChild,
      handoffPath: handoffPath!,
      handoff: interruptedHandoff
    })
  }
  if (isSupervisedSpawnHeld()) {
    return Promise.resolve(0)
  }
  const child = spawnServeChild(spec)
  const spawnedAt = Date.now()

  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    spec,
    spawnChild: spawnServeChild,
    child,
    handoffPath,
    expectedHandoff: null
  }).catch((error: unknown) => {
    // Why only a prompt abort: the registration abort kills the child before any JS runs.
    if (error instanceof MacServeStartupAbortError && Date.now() - spawnedAt < STARTUP_ABORT_MS) {
      recordElectronServeStartupAbort(userDataPath, error.message)
    }
    throw error
  })
}

export function getExecutableAppArgs(executable: string): string[] {
  const args = process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1' ? [resolveAppRoot()] : []
  if (needsElectronNoSandbox(executable)) {
    args.push('--no-sandbox')
  }
  return args
}

function getExecutableSpawnOptions(executable: string): Pick<SpawnOptions, 'shell'> {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) ? { shell: true } : {}
}

export function resolveAppRoot(): string {
  // Why: dev-mode resource resolution in the Electron child may consult
  // process.cwd(). Pin it to the app root so `orca serve` behaves the same
  // regardless of the shell directory it was launched from. A supervisor re-run from its copy
  // outside the app must still start the app's own files.
  return process.env[SERVE_SUPERVISOR_APP_ROOT_ENV] || resolve(__dirname, '../../..')
}

export function resolveForegroundOrcaExecutable(): string {
  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return overrideExecutable
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    return process.execPath
  }
  throw new RuntimeClientError('runtime_serve_failed', serverOnlyServeMessage(process.platform))
}

export function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  // Why: the request is applied as a switch; the server's terminals must not inherit it.
  delete next[ELECTRON_NO_SANDBOX_REQUEST_ENV]
  // Why: only the relocated supervisor itself may resolve its app root this way.
  delete next[SERVE_SUPERVISOR_APP_ROOT_ENV]
  return next
}
