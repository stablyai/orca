import { publishToDocuments } from '../../ipc/app-registry/app-handler-registry'
import type { MobileRelayStatusDetail } from '../../../shared/remote-runtime/relay/mobile-relay-status'
import { mainProcessState as state } from '../main-process-state'

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
  {
    const target1 = state.mainWindow
    if (target1) {
      publishToDocuments('mobile:relayStatusChanged', getDesktopRelayStatus(), {
        sourceId: target1.webContents.id
      })
    }
  }
}
