import { spawn, type SpawnOptions } from 'node:child_process'
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
import { getMacAppBundlePath } from './mac-app-update-bundle'
import { getPlatformUserDataPath } from './metadata'
import { isSameUserDataPath } from '../../shared/serve-user-data-path'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'
import {
  getExecutableAppArgs,
  resolveAppRoot,
  resolveForegroundOrcaExecutable,
  stripElectronRunAsNode
} from './orca-app-executable'
import { SERVE_RUNTIME_ELECTRON, SERVE_RUNTIME_ENV } from '../../shared/orcad-local-serve-selection'
import { findBundledWebClientRoot } from '../../shared/bundled-web-client-root'
import { resolveLocalServeRuntime, serveWithOrcad } from './serve-orcad-launch'
import { findAppSpeechRecognizerDir } from './serve-speech-recognizer'
import { stageAppAgentBrowserDriver } from './serve-agent-browser-driver'
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
import { relocateThisServeSupervisor } from './serve-supervisor-relocation'
import {
  noteServeSupervisorStart,
  restartThisServeSupervisorIfReplaced
} from './serve-replaced-app-restart'
import { isSupervisedSpawnHeld } from './serve-supervised-stop'
import { openServeBundlePark } from '../../shared/serve-bundle-park'
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

  // Launch on the same profile whose metadata openOrca awaits.
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
        // Launch the macOS bundle through Launch Services to preserve its app lifecycle.
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

/** Nondefault profiles need a new instance: open drops env and only new instances receive --args. */
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
  // Handle asynchronous spawn errors; openOrca reports startup failure via its timeout.
  child.once('error', () => {})
  child.unref()
}

export function serveOrcaApp(args: ServeOrcaAppArgs = {}): Promise<number> {
  // Install the PID 1 reaper before spawning so orphaned descendants are collected.
  reexecThisServeUnderInitReaper()
  noteServeSupervisorStart()
  const executable = resolveForegroundOrcaExecutable()
  // Runtime selection, orcad, and Electron must use the same profile.
  const userDataPath = resolveLaunchUserDataPath()
  if (args.supervise) {
    // Successful relocation replaces this process and never resolves.
    return relocateThisServeSupervisor(resolveAppRoot(), userDataPath).then(() => {
      let attempt = 0
      return superviseServeService({
        userDataPath,
        executable,
        appRoot: resolveAppRoot(),
        force: args.force === true,
        park: openServeBundlePark({ executable }),
        appImageUpdate: supervisedAppImageUpdate(executable, userDataPath, args.force === true),
        // --force overrides the brake once; later attempts use its updated state.
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
    // Exit 3 waits for the profile owner; orcad’s exit 78 would count against the crash brake.
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
      findBundledWebClientRoot(resolveAppRoot()),
      findAppSpeechRecognizerDir(resolveAppRoot()),
      await stageAppAgentBrowserDriver(resolveAppRoot(), userDataPath)
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
  // Isolated profiles need keychain bypass to avoid blocking readiness on authorization (#25453).
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
  const spawnServer: ServeSpawnChild = shouldRedactSupervisedStdout(args.supervise === true)
    ? redactingSpawn(spawnProcess)
    : spawnProcess
  // Check before every spawn after stop/park gates; overrides are not replaced by app updates.
  const spawnServeChild: ServeSpawnChild =
    handoffPath && executable === process.execPath
      ? (childSpec) => {
          restartThisServeSupervisorIfReplaced(resolveAppRoot())
          return spawnServer(childSpec)
        }
      : spawnServer
  const interruptedHandoff = handoffPath ? readServeUpdateHandoffSync(handoffPath) : null
  if (interruptedHandoff?.phase === 'install-requested') {
    // Node mode avoids NSRunningApplication registration, retaining launchd ownership during ShipIt swaps.
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
    // Registration aborts happen before child JS runs; record only immediate startup failures.
    if (error instanceof MacServeStartupAbortError && Date.now() - spawnedAt < STARTUP_ABORT_MS) {
      recordElectronServeStartupAbort(userDataPath, error.message)
    }
    throw error
  })
}

function getExecutableSpawnOptions(executable: string): Pick<SpawnOptions, 'shell'> {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) ? { shell: true } : {}
}
