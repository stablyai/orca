import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandResult } from './android-command-runner'

// The runner resolves nonzero exits; callers must explicitly reject unsuccessful actions.
export function ensureAdbOk(result: AndroidCommandResult, label: string): AndroidCommandResult {
  if (result.code !== 0) {
    throw new EmulatorError(
      'emulator_error',
      `${label} failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
    )
  }
  return result
}
