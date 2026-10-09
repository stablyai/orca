import { EmulatorError } from '../emulator-errors'
import type { HarmonyCommandResult } from './harmony-command-runner'

// The runner resolves non-zero exits as data; callers opt into throwing so hdc
// failures do not become silent successful emulator actions.
export function ensureHarmonyOk(result: HarmonyCommandResult, label: string): HarmonyCommandResult {
  if (result.code !== 0) {
    throw new EmulatorError(
      'emulator_error',
      `${label} failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
    )
  }
  return result
}
