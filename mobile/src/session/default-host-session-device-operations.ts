import type { HostSessionDeviceOperations } from './host-session-device-operations'
import { nativeHostSessionDeviceOperations } from './native-host-session-device-operations'

export function defaultHostSessionDeviceOperations(): HostSessionDeviceOperations {
  return nativeHostSessionDeviceOperations
}
