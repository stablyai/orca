import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { getWindowsAdministratorStatus } from './windows-administrator-status'

const RESTART_LOCAL_TERMINALS_ARG = '--orca-restart-local-terminals-as-administrator'
// Mirrors CANCELLED_EXIT_CODE in native/windows-cli-launcher/src/administrator_restart.rs.
const CANCELLED_EXIT_CODE = 2

export type WindowsAdministratorRestartRequest = 'approved' | 'cancelled'

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

/**
 * Asks Windows for approval while this desktop still owns the foreground; a launcher started
 * after exit (Electron's relauncher) gets its UAC prompt parked as a flashing taskbar button.
 * On approval an elevated launcher waits for this process to exit before starting Orca.
 */
export async function requestWindowsAdministratorRestart(
  ownerWindowHandle: Buffer | null
): Promise<WindowsAdministratorRestartRequest> {
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
  const elevatedParameters = [
    '--orca-relaunch-after-exit',
    String(process.pid),
    process.execPath,
    [...args, RESTART_LOCAL_TERMINALS_ARG].map(quoteWindowsArgument).join(' ')
  ]
    .map(quoteWindowsArgument)
    .join(' ')
  const result = await runProcess({
    program: launcher,
    args: [
      '--orca-restart-as-administrator',
      formatWindowHandle(ownerWindowHandle),
      elevatedParameters
    ],
    // The approval prompt waits on the user.
    timeoutMs: null,
    maxOutputBytes: 4096
  })
  if (result.code === 0) {
    return 'approved'
  }
  if (result.code === CANCELLED_EXIT_CODE) {
    return 'cancelled'
  }
  throw new Error(result.stderr.trim() || 'Windows did not start the administrator restart.')
}

function formatWindowHandle(handle: Buffer | null): string {
  if (handle?.length === 8) {
    return handle.readBigUInt64LE(0).toString()
  }
  return handle?.length === 4 ? String(handle.readUInt32LE(0)) : '0'
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
