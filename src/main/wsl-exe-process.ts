import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

export function wslExeProcessSpec(
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): ProcessSpec {
  // Deleted inherited worktree cwd also produces ENOENT, which must not mean WSL is absent.
  return { program: 'wsl.exe', args, env, timeoutMs, cwd: resolveWslInteropSpawnCwd() }
}

export function wslExeFailure(result: ProcessResult): string | null {
  if (result.code === 0) {
    return null
  }
  return result.timedOut
    ? 'wsl.exe timed out'
    : `wsl.exe exited with ${result.code ?? result.signal}`
}

export function wslExeStdout(result: ProcessResult): string {
  const failure = wslExeFailure(result)
  if (failure) {
    throw new Error(failure)
  }
  return result.stdout
}
