import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { RuntimeClientError } from './types'

export type ServeOrcaAppOptions = {
  json?: boolean
  port?: string | null
  pairingAddress?: string | null
  userDataPath?: string | null
  noPairing?: boolean
  mobilePairing?: boolean
  recipeJson?: boolean
  projectRoot?: string | null
}

type ServeOrcaAppHook = (args: ServeOrcaAppOptions) => Promise<number>

// Why: @stablyai/orca-server injects a Node-backed `serve` implementation here
// so the shared CLI can start the headless runtime without launching Electron.
declare global {
  var __ORCA_NODE_SERVER_SERVE__: ServeOrcaAppHook | undefined
}

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

export function serveOrcaApp(args: ServeOrcaAppOptions = {}): Promise<number> {
  const nodeServerServe = globalThis.__ORCA_NODE_SERVER_SERVE__
  if (nodeServerServe) {
    return nodeServerServe(args)
  }
  if (args.userDataPath) {
    throw new RuntimeClientError(
      'unsupported_argument',
      '`orca serve --user-data` is only supported by @stablyai/orca-server.'
    )
  }

  const executable = resolveForegroundOrcaExecutable()
  const childArgs = [...getExecutableAppArgs(), '--serve']
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

  const child = spawnProcess(executable, childArgs, {
    detached: args.recipeJson === true,
    cwd: resolveAppRoot(),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...getExecutableSpawnOptions(executable),
    env: stripElectronRunAsNode(process.env)
  })

  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }

  return new Promise((resolve, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal)
      forceKillTimer ??= setTimeout(() => {
        child.kill('SIGKILL')
      }, 5000)
    }
    const cleanup = (): void => {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      reject(new RuntimeClientError('runtime_serve_failed', `Orca serve exited via ${signal}`))
    })
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
      child.off('exit', onExit)
      if (error) {
        reject(error)
        return
      }
      child.stdout?.destroy?.()
      child.unref()
      resolve(0)
    }
    const emitLine = (line: string): void => {
      process.stdout.write(`${line}\n`)
      finish()
    }
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const newlineIndex = output.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      emitLine(output.slice(0, newlineIndex))
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      const trimmed = output.trim()
      if (trimmed) {
        emitLine(trimmed)
        return
      }
      finish(
        new RuntimeClientError(
          'runtime_serve_failed',
          typeof code === 'number'
            ? `Orca serve exited before printing recipe JSON with code ${code}.`
            : `Orca serve exited before printing recipe JSON via ${signal}.`
        )
      )
    }
    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
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

function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}

function getMacAppBundlePath(execPath: string): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const macOsDir = dirname(execPath)
  const contentsDir = dirname(macOsDir)
  const appBundlePath = dirname(contentsDir)
  return appBundlePath.endsWith('.app') ? appBundlePath : null
}
