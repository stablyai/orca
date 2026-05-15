import { spawn as spawnProcess } from 'child_process'
import { dirname, resolve } from 'path'
import { RuntimeClientError } from './types'

export function launchOrcaApp(): void {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnProcess(overrideCommand, {
      detached: true,
      stdio: 'ignore',
      shell: true
    }).unref()
    return
  }

  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    spawnProcess(overrideExecutable, [], {
      detached: true,
      stdio: 'ignore',
      env: stripElectronRunAsNode(process.env)
    }).unref()
    return
  }

  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    if (process.platform === 'darwin') {
      const appBundlePath = getMacAppBundlePath(process.execPath)
      if (appBundlePath) {
        // Why: launching the inner MacOS binary directly can trigger macOS app
        // launch failures and bypass normal bundle lifecycle. The public
        // packaged CLI should re-open the .app the same way Finder does.
        spawnProcess('open', [appBundlePath], {
          detached: true,
          stdio: 'ignore',
          env: stripElectronRunAsNode(process.env)
        }).unref()
        return
      }
    }

    spawnProcess(process.execPath, [], {
      detached: true,
      stdio: 'ignore',
      env: stripElectronRunAsNode(process.env)
    }).unref()
    return
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Orca. Start Orca manually and try again.'
  )
}

export function serveOrcaApp(
  args: {
    json?: boolean
    port?: string | null
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
  } = {}
): Promise<number> {
  const executable = resolveForegroundOrcaExecutable()
  const childArgs = ['--serve']
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

  const child = spawnProcess(executable, childArgs, {
    cwd: resolveAppRoot(),
    stdio: 'inherit',
    env: stripElectronRunAsNode(process.env)
  })

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
