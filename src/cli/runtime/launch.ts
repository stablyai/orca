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
import { getDefaultUserDataPath } from './metadata'
import { getMacAppBundlePath } from './mac-app-update-bundle'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'

const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'

export function launchOrcaApp(): void {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnDetached(overrideCommand, [], { shell: true })
    return
  }

  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    spawnDetached(overrideExecutable, getExecutableAppArgs(), {
      ...getExecutableSpawnOptions(overrideExecutable),
      env: stripElectronRunAsNode(process.env)
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

export function serveOrcaApp(
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
