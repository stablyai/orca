import {
  emulatorCodedMessage,
  matchEmulatorErrorCopy,
  type EmulatorCodedMessage,
  type EmulatorFailureCode
} from '../../shared/emulator-failure-copy'

// Keep error codes stable: agents and CLI callers depend on them.
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
  | 'emulator_unsupported'
  | 'emulator_error'

/** Coded availability text for a caught setup error; non-Errors use the fallback sentence. */
export function emulatorErrorCodedMessage(
  error: unknown,
  fallback: EmulatorFailureCode
): EmulatorCodedMessage {
  if (!(error instanceof Error)) {
    return emulatorCodedMessage(fallback)
  }
  const copy =
    error instanceof EmulatorError ? matchEmulatorErrorCopy(error.code, error.message) : null
  if (!copy) {
    return { message: error.message }
  }
  return {
    message: error.message,
    messageCode: copy.code,
    ...(Object.keys(copy.params).length > 0 ? { messageParams: copy.params } : {})
  }
}
