import type { MobileRelayStatusDetail } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import { mainProcessState as state } from '../main-process-state'

export function getDesktopRelayStatus(): MobileRelayStatusDetail {
  return { ...state.core.desktopRelayStatus }
}

export function publishDesktopRelayStatus(
  status: MobileRelayStatusDetail['status'],
  cellUrl?: string,
  clockOffsetMs?: number
): void {
  state.core.desktopRelayStatus = {
    status,
    ...(cellUrl === undefined ? {} : { cellUrl }),
    ...(clockOffsetMs === undefined ? {} : { clockOffsetMs })
  }
  state.mainWindow?.webContents.send('mobile:relayStatusChanged', getDesktopRelayStatus())
}
