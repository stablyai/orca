import { ipcMain } from 'electron'
import { sameEndpointIdentity } from '../daemon/daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import { getCurrentDaemonAdapter } from '../daemon/daemon-provider-routing'
import { getDaemonProvider, listLiveDaemonPtyIds } from '../daemon/daemon-provider-state'
import { consumeLocalTerminalRestartRequest } from './windows-administrator-restart'
import {
  getProcessAdministratorStatus,
  getWindowsAdministratorStatus
} from './windows-administrator-status'

/** A terminal host started without administrator rights, adopted by an elevated desktop. */
export type WindowsStandardTerminalHost = { pid: number; liveSessionCount: number | null }

export type WindowsStandardTerminalHostRestartResult =
  | { status: 'restarted'; killedCount: number }
  | { status: 'refused'; reason: 'replaced' }

let standardHost: DaemonEndpointIdentity | null = null

function readCurrentDaemonIdentity(): DaemonEndpointIdentity | null {
  const provider = getDaemonProvider()
  return provider ? getCurrentDaemonAdapter(provider).getDaemonIdentity() : null
}

function isCurrentStandardHost(host: DaemonEndpointIdentity): boolean {
  const current = readCurrentDaemonIdentity()
  return current !== null && sameEndpointIdentity(current, host)
}

/**
 * Terminal hosts outlive the desktop, so an elevated launch adopts the previous host's token.
 * Replace it when that was requested or ends nothing; otherwise leave the choice to the user.
 */
export async function reconcileTerminalHostElevation(signal: AbortSignal): Promise<void> {
  const restartRequested = consumeLocalTerminalRestartRequest()
  if (
    process.platform !== 'win32' ||
    signal.aborted ||
    (await getWindowsAdministratorStatus()) !== true ||
    signal.aborted
  ) {
    return
  }
  const { restartDaemon } = await import('../daemon/daemon-provider-restart')
  if (restartRequested) {
    await restartDaemon()
    return
  }
  const identity = readCurrentDaemonIdentity()
  if (
    !identity ||
    (await getProcessAdministratorStatus(identity.pid)) !== false ||
    signal.aborted
  ) {
    return
  }
  if ((await listLiveDaemonPtyIds())?.length === 0) {
    try {
      await restartDaemon({ expectedDaemonPid: identity.pid })
      return
    } catch (error) {
      console.warn(
        '[windows-administrator] Replacing the empty terminal host failed:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  standardHost = identity
}

export async function readWindowsStandardTerminalHost(): Promise<WindowsStandardTerminalHost | null> {
  const host = standardHost
  if (!host || !isCurrentStandardHost(host)) {
    return null
  }
  const live = await listLiveDaemonPtyIds().catch(() => null)
  return { pid: host.pid, liveSessionCount: live?.length ?? null }
}

export async function restartWindowsStandardTerminalHost(
  expectedPid: number
): Promise<WindowsStandardTerminalHostRestartResult> {
  const host = standardHost
  if (!host || host.pid !== expectedPid || !isCurrentStandardHost(host)) {
    return { status: 'refused', reason: 'replaced' }
  }
  const { restartDaemon } = await import('../daemon/daemon-provider-restart')
  const { killedCount } = await restartDaemon({ expectedDaemonPid: expectedPid })
  if (standardHost === host) {
    standardHost = null
  }
  return { status: 'restarted', killedCount }
}

export function registerWindowsStandardTerminalHostHandlers(): void {
  ipcMain.removeHandler('pty:management:windowsStandardTerminalHost')
  ipcMain.removeHandler('pty:management:restartWindowsStandardTerminalHost')
  ipcMain.handle('pty:management:windowsStandardTerminalHost', async () => ({
    host: await readWindowsStandardTerminalHost().catch(() => null)
  }))
  ipcMain.handle(
    'pty:management:restartWindowsStandardTerminalHost',
    async (_event, expectedPid: unknown): Promise<WindowsStandardTerminalHostRestartResult> =>
      typeof expectedPid === 'number' && Number.isSafeInteger(expectedPid) && expectedPid > 0
        ? restartWindowsStandardTerminalHost(expectedPid)
        : { status: 'refused', reason: 'replaced' }
  )
}
