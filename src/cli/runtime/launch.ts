import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../../shared/serve-update-handoff'
import {
  getEphemeralVmRecipeResultConnection,
  parseEphemeralVmRecipeResult
} from '../../shared/ephemeral-vm-recipes'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'
import { getDefaultUserDataPath, tryReadMetadata } from './metadata'
import { getMacAppBundlePath } from './mac-app-update-bundle'
import {
  findServingProfileOwner,
  serveAlreadyRunningFailure,
  serveAlreadyRunningMessage
} from './serving-profile-owner'
import { getCliStatus } from './status'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'

const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'

export type OrcaLaunchFailure = {
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when the command never started, in which case no exit ever follows. */
  spawnError?: string
}

export type OrcaAppLaunch = {
  /** Non-null once the launched process died without producing a window. */
  readonly failedExit: () => OrcaLaunchFailure | null
}

export function launchOrcaApp(): OrcaAppLaunch {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    return spawnDetached(overrideCommand, [], { shell: true })
  }

  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return spawnDetached(overrideExecutable, getExecutableAppArgs(), {
      ...getExecutableSpawnOptions(overrideExecutable),
      env: stripElectronRunAsNode(process.env)
    })
  }

  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    if (process.platform === 'darwin') {
      const appBundlePath = getMacAppBundlePath(process.execPath)
      if (appBundlePath) {
        // Why: launching the inner MacOS binary directly can trigger macOS app
        // launch failures and bypass normal bundle lifecycle. The public
        // packaged CLI should re-open the .app the same way Finder does.
        return spawnDetached('open', [appBundlePath], {
          env: stripElectronRunAsNode(process.env)
        })
      }
    }

    return spawnDetached(process.execPath, [], {
      env: stripElectronRunAsNode(process.env)
    })
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Orca. Start Orca manually and try again.'
  )
}

function spawnDetached(command: string, args: string[], options: SpawnOptions): OrcaAppLaunch {
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
    ...options
  })
  let failedExit: OrcaLaunchFailure | null = null
  // Why: a pre-JS abort kills this child in ~200ms; unwatched, `orca open` can only
  // blame a 15s "no window" timeout. exit(0) is normal — `open` returns on accept.
  child.once('exit', (code, signal) => {
    if (signal !== null || (code !== null && code !== 0)) {
      failedExit = { code, signal }
    }
  })
  // Why: a command that never starts emits `error` and no `exit`, so discarding it
  // leaves openOrca waiting out its window for a process that was never created.
  child.once('error', (error: NodeJS.ErrnoException) => {
    failedExit ??= { code: null, signal: null, spawnError: error.message }
  })
  child.unref()
  return { failedExit: () => failedExit }
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
  const userDataPath = getDefaultUserDataPath()
  const owner = await findServingProfileOwner(
    (await getCliStatus(userDataPath)).result,
    // Why: re-read deliberately — a runtime that has since removed its metadata is
    // shutting down, and one that rewrote it published the endpoint worth probing.
    tryReadMetadata(userDataPath)
  )
  if (owner) {
    // Why: the Electron main enforces this rule only after NSApplication init, which
    // aborts pre-JS when Launch Services is unreachable (STA-4336) — so a supervisor's
    // retry becomes a SIGABRT loop unless the CLI refuses first.
    // Recipe stdout carries a strict result schema and nothing else, so the envelope
    // would corrupt that channel; exit 3 is its signal.
    if (args.json === true && args.recipeJson !== true) {
      process.stdout.write(`${JSON.stringify(serveAlreadyRunningFailure(owner), null, 2)}\n`)
    } else {
      process.stderr.write(`${serveAlreadyRunningMessage(owner)}\n`)
    }
    return SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
  }
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
      ? getServeUpdateHandoffPath(userDataPath)
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

function waitForRecipeJson(child: ReturnType<typeof spawnProcess>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => {
      finish(new RuntimeClientError('runtime_serve_failed', 'Timed out waiting for recipe JSON.'))
      child.kill('SIGTERM')
    }, 60000)
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      if (error) {
        reject(error)
        return
      }
      child.stdout?.destroy?.()
      child.unref()
      resolve(0)
    }
    const writeIgnoredRecipeStdout = (): void => {
      // Why: non-readiness child stdout is untrusted and cannot be safely
      // redacted, including schema-valid results with arbitrary user data.
      process.stderr.write(`${IGNORED_NON_RECIPE_STDOUT}\n`)
    }
    const processRecipeOutputLine = (line: string): void => {
      const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
      if (!normalizedLine.trim()) {
        return
      }
      const parsed = parseEphemeralVmRecipeResult(normalizedLine)
      if (!parsed.ok) {
        writeIgnoredRecipeStdout()
        return
      }
      if (getEphemeralVmRecipeResultConnection(parsed.result).type !== 'orca-server') {
        writeIgnoredRecipeStdout()
        return
      }
      process.stdout.write(`${normalizedLine.trim()}\n`)
      finish()
    }
    const stdoutDecoder = new StringDecoder('utf8')
    const onData = (chunk: Buffer | string): void => {
      output += typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk)
      while (!settled) {
        const newlineIndex = output.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const line = output.slice(0, newlineIndex)
        output = output.slice(newlineIndex + 1)
        processRecipeOutputLine(line)
      }
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      output += stdoutDecoder.end()
      if (output.trim()) {
        processRecipeOutputLine(output)
      }
      if (settled) {
        return
      }
      finish(
        new RuntimeClientError(
          'runtime_serve_failed',
          typeof code === 'number'
            ? `Orca serve exited before printing valid recipe JSON with code ${code}.`
            : `Orca serve exited before printing valid recipe JSON via ${signal}.`
        )
      )
    }
    child.stdout?.on('data', onData)
    child.once('error', onError)
    // Why: `exit` can precede the final piped stdout data. `close` waits until
    // stdio closes so a last recipe chunk is not mistaken for missing output.
    child.once('close', onClose)
  })
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
