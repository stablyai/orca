// Why: shared error codes for emulator (mirrors BrowserErrorCode in shared/runtime-types; used by bridge, runtime, dispatcher, CLI handlers, skill examples). Keep codes stable for agents.
export class EmulatorError extends Error {
  code: EmulatorErrorCode
  constructor(code: EmulatorErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'EmulatorError'
  }
}

// One message for every path that hits a configured-but-disconnected ADB
// network serial (boot, resolve, input, shutdown), so guidance never drifts.
export function adbDeviceNotConnectedError(serial: string): EmulatorError {
  return new EmulatorError(
    'emulator_adb_not_connected',
    `ADB device ${serial} is not connected. Connect it in Settings > Mobile Emulator.`
  )
}

export type EmulatorErrorCode =
  | 'emulator_no_active'
  | 'emulator_device_not_found'
  | 'emulator_helper_failed'
  | 'emulator_simctl_unavailable'
  | 'emulator_not_macos'
  | 'emulator_disabled'
  | 'emulator_unsupported'
  | 'emulator_error'
  | 'emulator_adb_missing'
  | 'emulator_adb_address_invalid'
  | 'emulator_adb_address_unsupported'
  | 'emulator_adb_unauthorized'
  | 'emulator_adb_offline'
  | 'emulator_adb_not_connected'
  | 'emulator_adb_connect_failed'
  | 'emulator_adb_connect_timeout'
  | 'emulator_adb_disconnect_failed'
