import { spawn as spawnProcess } from 'child_process'
import { dirname } from 'path'
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
