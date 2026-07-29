import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandResult } from './android-command-runner'

// AndroidCommandRunner resolves non-zero exits as data; callers must opt into
// throwing so adb failures do not become silent successful emulator actions.
export function ensureAdbOk(result: AndroidCommandResult, label: string): AndroidCommandResult {
  if (result.code !== 0) {
    throw new EmulatorError(
      'emulator_error',
      `${label} failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
    )
  }
  return result
}
