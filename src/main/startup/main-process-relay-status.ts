import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
import { mainProcessState as state } from './main-process-state'

export function getDesktopRelayStatus(): MobileRelayStatusDetail {
  return {
    status: state.desktopRelayStatus,
    ...(state.desktopRelayCellUrl === undefined ? {} : { cellUrl: state.desktopRelayCellUrl })
  }
}

export function publishDesktopRelayStatus(
  status: MobileRelayStatusDetail['status'],
  cellUrl?: string
): void {
  state.desktopRelayStatus = status
  state.desktopRelayCellUrl = cellUrl
  // Why isDestroyed and not just the optional chain: `state.mainWindow` is nulled on 'closed',
  // so between destroy and that event `webContents.send` throws "Object has been destroyed".
  // This runs from inside a bare `setTimeout` recovery step, where a throw killed the retry chain.
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('mobile:relayStatusChanged', getDesktopRelayStatus())
  }
}
