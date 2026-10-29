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
  state.mainWindow?.webContents.send('mobile:relayStatusChanged', getDesktopRelayStatus())
}
