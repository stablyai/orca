import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { basename, resolve } from 'node:path'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../../shared/serve-update-handoff'
import { acquireForegroundServeLock, releaseForegroundServeLock } from './foreground-serve-lock'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  SERVE_ALREADY_RUNNING_MESSAGE,
  shouldSpawnForegroundServe
} from './foreground-serve-policy'
import { getMacAppBundlePath } from './mac-app-update-bundle'
import { getDefaultUserDataPath } from './metadata'
import { waitForRecipeJson } from './serve-recipe-json'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { getCliStatus } from './status'
import { RuntimeClientError } from './types'

export function launchOrcaApp(): void {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnDetached(overrideCommand, [], { shell: true })
    return
  }

  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    const packagedBundlePath = packagedOrcaAppBundlePath(overrideExecutable)
    if (packagedBundlePath) {
      // Why: exec'ing Contents/MacOS/Orca skips Launch Services. On macOS 26 that
      // aborts in +[NSApplication sharedApplication] / _RegisterApplication
      // before any JS runs. Dev Electron lives in Electron.app and must still
      // be exec'd with the app root — only the packaged Orca.app is re-opened.
      spawnDetached('open', [packagedBundlePath], {
        env: stripElectronRunAsNode(process.env)
      })
      return
    }
    spawnDetached(overrideExecutable, getExecutableAppArgs(), {
      ...getExecutableSpawnOptions(overrideExecutable),
      env: stripElectronRunAsNode(process.env)
    })
    return
  }

  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    if (process.platform === 'darwin') {
      const appBundlePath = packagedOrcaAppBundlePath(process.execPath)
      if (appBundlePath) {
        // Why: launching the inner MacOS binary directly can trigger macOS app
        // launch failures and bypass normal bundle lifecycle. The public
        // packaged CLI should re-open the .app the same way Finder does.
        spawnDetached('open', [appBundlePath], {
          env: stripElectronRunAsNode(process.env)
        })
        return
      }
    }

    spawnDetached(process.execPath, [], {
      env: stripElectronRunAsNode(process.env)
    })
    return
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Orca. Start Orca manually and try again.'
  )
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

export async function serveOrcaApp(
  args: {
    json?: boolean
    port?: string | null
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    recipeJson?: boolean
    projectRoot?: string | null
  } = {}
): Promise<number> {
  if (args.recipeJson === true) {
    return spawnForegroundServe(args)
  }

  // Why: two CLIs can both see an idle profile and both exec Electron before
  // JS's single-instance lock runs. Reserve the profile first, then spawn.
  const userDataPath = getDefaultUserDataPath()
  const lock = await acquireForegroundServeLock(userDataPath)
  if (!lock) {
    process.stderr.write(`${SERVE_ALREADY_RUNNING_MESSAGE}\n`)
    return SERVE_ALREADY_RUNNING_EXIT_CODE
  }
  try {
    const status = await getCliStatus(userDataPath)
    if (!shouldSpawnForegroundServe(status.result)) {
      process.stderr.write(`${SERVE_ALREADY_RUNNING_MESSAGE}\n`)
      return SERVE_ALREADY_RUNNING_EXIT_CODE
    }
    return await spawnForegroundServe(args)
  } finally {
    await releaseForegroundServeLock(lock)
  }
}

async function spawnForegroundServe(args: Parameters<typeof serveOrcaApp>[0]): Promise<number> {
  const executable = resolveForegroundOrcaExecutable()
  const childArgs = [...getExecutableAppArgs()]
  if (process.env.ORCA_APPIMAGE_NO_SANDBOX === '1') {
    childArgs.push('--no-sandbox')
  }
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
  if (args.recipeJson) {
    if (!args.projectRoot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires --project-root.'
      )
    }
    childArgs.push('--serve-recipe-json', '--serve-project-root', args.projectRoot)
  }

  const handoffPath =
    args.recipeJson !== true && getMacAppBundlePath(executable)
      ? getServeUpdateHandoffPath(getDefaultUserDataPath())
      : null
  const childEnv = stripElectronRunAsNode(process.env)
  delete childEnv.ORCA_APPIMAGE_NO_SANDBOX
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

function packagedOrcaAppBundlePath(executable: string): string | null {
  const appBundlePath = getMacAppBundlePath(executable)
  if (!appBundlePath) {
    return null
  }
  return basename(appBundlePath) === 'Orca.app' ? appBundlePath : null
}

function getExecutableAppArgs(): string[] {
  return process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1' ? [resolveAppRoot()] : []
}

function getExecutableSpawnOptions(executable: string): Pick<SpawnOptions, 'shell'> {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) ? { shell: true } : {}
}

function resolveAppRoot(): string {
  // Why: dev-mode resource resolution in the Electron child may consult
  // process.cwd(). Pin it to the app root so `orca serve` behaves the same
  // regardless of the shell directory it was launched from.
  return resolve(__dirname, '../../..')
}

function resolveForegroundOrcaExecutable(): string {
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
