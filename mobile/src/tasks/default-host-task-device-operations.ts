import type { HostTaskDeviceOperations } from './host-task-device-operations'
import { nativeHostTaskDeviceOperations } from './native-host-task-device-operations'

export function defaultHostTaskDeviceOperations(): HostTaskDeviceOperations {
  return nativeHostTaskDeviceOperations
}
