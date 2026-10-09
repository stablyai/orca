import { basename } from 'node:path'
import { runProcess } from '@orca/process-host'
import { emulatorProbe, emulatorProbeError } from '../emulator-probe'

export type HarmonyCommandResult = { stdout: string; stderr: string; code: number }

// Runs a HarmonyOS toolchain binary (hdc/Emulator) and resolves with its
// output. Never rejects — callers branch on `code` so a non-zero exit is data.
export type HarmonyCommandRunner = (
  binary: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<HarmonyCommandResult>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BUFFER_BYTES = 16 * 1024 * 1024

export const runProcessHarmonyCommandRunner: HarmonyCommandRunner = async (
  binary,
  args,
  options
) => {
  // runProcess rejects only when the binary cannot start; surface that as a
  // failed result so callers keep the never-rejects contract.
  const result = await runProcess(
    {
      program: binary,
      args: [...args],
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_BUFFER_BYTES
    },
    'tail'
  ).catch((error: unknown) => ({
    code: null,
    signal: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'failed to start',
    timedOut: false
  }))

  const code = result.code ?? 1
  const resolved = { stdout: result.stdout, stderr: result.stderr, code }
  if (code === 0) {
    emulatorProbe('cmd', { bin: basename(binary), args })
  } else {
    emulatorProbeError('cmd.fail', new Error(resolved.stderr || 'nonzero exit'), {
      bin: basename(binary),
      args,
      code,
      stderr: resolved.stderr.slice(0, 400)
    })
  }
  return resolved
}
