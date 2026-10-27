import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { emulatorProbe, emulatorProbeError } from '../emulator-probe'

export type AndroidCommandResult = { stdout: string; stderr: string; code: number }

/** Nonzero exits resolve as data; callers must check code. */
export type AndroidCommandRunner = (
  binary: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<AndroidCommandResult>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BUFFER_BYTES = 16 * 1024 * 1024

export const execFileAndroidCommandRunner: AndroidCommandRunner = (binary, args, options) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        const result = {
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          code: exitCode
        }
        if (exitCode === 0) {
          emulatorProbe('cmd', { bin: basename(binary), args })
        } else {
          emulatorProbeError('cmd.fail', error ?? new Error(result.stderr || 'nonzero exit'), {
            bin: basename(binary),
            args,
            code: exitCode,
            stderr: result.stderr.slice(0, 400)
          })
        }
        resolve(result)
      }
    )
  })
