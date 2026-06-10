// Why: shared error codes for emulator (mirrors BrowserErrorCode in shared/runtime-types; used by bridge, runtime, dispatcher, CLI handlers, skill examples). Keep codes stable for agents.
export class EmulatorError extends Error {
  code: EmulatorErrorCode
  constructor(code: EmulatorErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'EmulatorError'
  }
}

export type EmulatorErrorCode =
  | 'emulator_no_active'
  | 'emulator_device_not_found'
  | 'emulator_helper_failed'
  | 'emulator_simctl_unavailable'
  | 'emulator_not_macos'
  | 'emulator_disabled'
  | 'emulator_error'
