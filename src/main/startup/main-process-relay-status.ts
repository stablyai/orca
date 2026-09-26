import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
import { mainProcessState as state } from './main-process-state'

export function getDesktopRelayStatus(): MobileRelayStatusDetail {
  return state.desktopRelayService?.getStatus() ?? { status: 'offline' }
}

export function publishDesktopRelayStatus(detail: MobileRelayStatusDetail): void {
  state.mainWindow?.webContents.send('mobile:relayStatusChanged', detail)
}
