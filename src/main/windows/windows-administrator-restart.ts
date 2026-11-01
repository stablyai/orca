import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { app } from 'electron'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { getWindowsAdministratorStatus } from './windows-administrator-status'

const RESTART_LOCAL_TERMINALS_ARG = '--orca-restart-local-terminals-as-administrator'

export function getWindowsAdministratorRelaunchOptions(): Electron.RelaunchOptions | undefined {
  if (
    process.platform !== 'win32' ||
    !app.commandLine.hasSwitch(RESTART_LOCAL_TERMINALS_ARG.slice(2))
  ) {
    return undefined
  }
  // Electron's default relaunch retains native startup arguments after JS consumes the request.
  return { args: process.argv.slice(1).filter((arg) => arg !== RESTART_LOCAL_TERMINALS_ARG) }
}

export function prepareWindowsAdministratorRestart(): Electron.RelaunchOptions {
  if (process.platform !== 'win32' || !app.isPackaged) {
    throw new Error('Administrator restart requires the installed Windows app.')
  }
  const cliLauncher = getBundledLauncherPath('win32', process.resourcesPath)
  const launcher =
    cliLauncher && win32.join(win32.dirname(cliLauncher), 'orca-administrator-restart.exe')
  if (!launcher || !existsSync(launcher)) {
    throw new Error('The Windows administrator launcher is unavailable.')
  }
  const args = process.argv.slice(1).filter((arg) => arg !== RESTART_LOCAL_TERMINALS_ARG)
  return {
    execPath: launcher,
    args: [
      '--orca-restart-as-administrator',
      process.execPath,
      [...args, RESTART_LOCAL_TERMINALS_ARG].map(quoteWindowsArgument).join(' '),
      args.map(quoteWindowsArgument).join(' ')
    ]
  }
}

export async function restartLocalTerminalsAfterElevation(signal: AbortSignal): Promise<void> {
  if (process.platform !== 'win32' || !process.argv.includes(RESTART_LOCAL_TERMINALS_ARG)) {
    return
  }
  // Consume the request so an unrelated later app restart cannot end terminal work again.
  process.argv = process.argv.filter((arg) => arg !== RESTART_LOCAL_TERMINALS_ARG)
  if (signal.aborted || (await getWindowsAdministratorStatus()) !== true || signal.aborted) {
    return
  }
  const { restartDaemon } = await import('../daemon/daemon-provider-restart')
  await restartDaemon()
}
