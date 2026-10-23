import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

/** A host-side `wsl.exe` call (`--list`, `--status`, `-d <distro> --exec ...`). */
export function wslExeProcessSpec(
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): ProcessSpec {
  // Why an explicit cwd (#16463): an inherited one can be a deleted worktree, which
  // makes every spawn fail ENOENT and reads as "WSL is not installed".
  return { program: 'wsl.exe', args, env, timeoutMs, cwd: resolveWslInteropSpawnCwd() }
}

/** Why a `wsl.exe` call failed, or null for a clean exit. */
export function wslExeFailure(result: ProcessResult): string | null {
  if (result.code === 0) {
    return null
  }
  return result.timedOut
    ? 'wsl.exe timed out'
    : `wsl.exe exited with ${result.code ?? result.signal}`
}

/** Stdout of a clean exit; throws for any other outcome. */
export function wslExeStdout(result: ProcessResult): string {
  const failure = wslExeFailure(result)
  if (failure) {
    throw new Error(failure)
  }
  return result.stdout
}
