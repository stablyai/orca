import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
import { mainProcessState as state } from './main-process-state'

export function getDesktopRelayStatus(): MobileRelayStatusDetail {
  return { ...state.desktopRelayStatus }
}

export function publishDesktopRelayStatus(
  status: MobileRelayStatusDetail['status'],
  cellUrl?: string,
  clockOffsetMs?: number
): void {
  state.desktopRelayStatus = {
    status,
    ...(cellUrl === undefined ? {} : { cellUrl }),
    ...(clockOffsetMs === undefined ? {} : { clockOffsetMs })
  }
  state.mainWindow?.webContents.send('mobile:relayStatusChanged', getDesktopRelayStatus())
}
