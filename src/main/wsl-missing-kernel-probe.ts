import { runProcess, runProcessSync, type ProcessSpec } from '../shared/child-process/run-process'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

export function isWslMissingKernelError(error: unknown): boolean {
  const failure = error as { code?: unknown; status?: unknown } | null
  // Node preserves the Windows DWORD; PowerShell displays its signed equivalent.
  return [failure?.code, failure?.status].some((code) => code === -444 || code === 4_294_966_852)
}

function defaultGuestProbe(): ProcessSpec {
  return {
    program: 'wsl.exe',
    args: buildWslExecArgs(undefined, ['/bin/true']),
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: 5000,
    maxOutputBytes: 4096
  }
}

// WSL1 can execute normally while --status rejects a missing WSL2 kernel.
export async function canExecuteWslWithoutKernel(): Promise<boolean> {
  try {
    const result = await runProcess(defaultGuestProbe())
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

export function canExecuteWslWithoutKernelSync(): boolean {
  try {
    const result = runProcessSync(defaultGuestProbe())
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}
