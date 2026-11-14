/** A person's view of SSH hosts driving desktop browser tabs: a once-per-host notice, Stop, and Don't allow. */
import { ipcMain, type BrowserWindow } from 'electron'
import {
  DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL,
  DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL,
  DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL,
  type DesktopBrowserBridgeHostNotice
} from '../../../shared/desktop-browser-bridge-host-control-contract'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { SshTarget } from '../../../shared/ssh-types'
import { isRuntimeOwnedSshTarget } from '../../ssh/targets/ssh-target-runtime-ownership'
import { setDesktopBrowserBridgeHostStopped } from './desktop-browser-bridge-reconcile'

/** Old entries fall off so runtime-created hosts cannot grow the list without bound. */
const MAX_NOTICED_HOSTS = 200

type NoticedHostsKey = 'desktopBrowserBridgeNoticedTargetIds'

export type DesktopBrowserBridgeHostControlDeps = {
  settings: {
    getSettings(): Pick<GlobalSettings, NoticedHostsKey>
    updateSettings(updates: Pick<GlobalSettings, NoticedHostsKey>): unknown
  } | null
  targets: {
    getTarget(id: string): SshTarget | undefined
    updateTarget(id: string, updates: Pick<SshTarget, 'allowRemoteCliControl'>): unknown
  } | null
  /** Clears the agent marking from tabs this host was driving. */
  endHostActivity(targetId: string): void
}

/** Fire-and-forget: the host's command never waits on the notice or on anyone answering it. */
export function noticeDesktopBrowserBridgeHostControl(
  host: { targetId: string; hostLabel: string },
  getMainWindow: () => BrowserWindow | null,
  deps: Pick<DesktopBrowserBridgeHostControlDeps, 'settings' | 'targets'>
): void {
  const noticed = deps.settings?.getSettings().desktopBrowserBridgeNoticedTargetIds ?? []
  if (!deps.settings || noticed.includes(host.targetId)) {
    return
  }
  const contents = getMainWindow()?.webContents
  if (!contents || contents.isDestroyed()) {
    return
  }
  deps.settings.updateSettings({
    desktopBrowserBridgeNoticedTargetIds: [...noticed, host.targetId].slice(-MAX_NOTICED_HOSTS)
  })
  const target = deps.targets?.getTarget(host.targetId)
  const notice: DesktopBrowserBridgeHostNotice = {
    targetId: host.targetId,
    hostLabel: host.hostLabel,
    canDisallow: target !== undefined && !isRuntimeOwnedSshTarget(target)
  }
  contents.send(DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL, notice)
}

/** Detaches the host now, cancelling its queued and running commands, until restart or re-enable. */
export function stopDesktopBrowserBridgeHost(
  targetId: string,
  deps: Pick<DesktopBrowserBridgeHostControlDeps, 'endHostActivity'>
): void {
  setDesktopBrowserBridgeHostStopped(targetId, true)
  deps.endHostActivity(targetId)
}

/** Turns the host's setting off; hosts Orca created itself are only stopped. */
export function disallowDesktopBrowserBridgeHost(
  targetId: string,
  deps: DesktopBrowserBridgeHostControlDeps
): boolean {
  stopDesktopBrowserBridgeHost(targetId, deps)
  const target = deps.targets?.getTarget(targetId)
  if (!deps.targets || !target || isRuntimeOwnedSshTarget(target)) {
    return false
  }
  deps.targets.updateTarget(targetId, { allowRemoteCliControl: false })
  return true
}

export function registerDesktopBrowserBridgeHostControlIpc(
  deps: () => DesktopBrowserBridgeHostControlDeps
): void {
  ipcMain.removeHandler(DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL)
  ipcMain.removeHandler(DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL)
  ipcMain.handle(DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL, (_event, targetId: unknown) => {
    if (typeof targetId === 'string' && targetId) {
      stopDesktopBrowserBridgeHost(targetId, deps())
    }
  })
  ipcMain.handle(DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL, (_event, targetId: unknown) =>
    typeof targetId === 'string' && targetId
      ? disallowDesktopBrowserBridgeHost(targetId, deps())
      : false
  )
}
