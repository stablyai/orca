import { execFileSync, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { untranslatedGitOutputEnv } from './git-process-env'
import { resolveCommand } from './wsl-command-resolution'

// Bound synchronous Git: a dead network drive can freeze the main thread.
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

type HostGitOnly = true

/**
 * Return trimmed stdout; prefer async execution to avoid blocking main. Host Git, never routed:
 * routing would turn this one main-thread launch into a synchronous wsl.exe.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    /** Every caller is host-only; see the routing guard test. */
    hostGit: HostGitOnly
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
    timeout?: number
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  const spawnStartedAt = performance.now()
  try {
    return execFileSync(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      env: untranslatedGitOutputEnv(),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS,
      windowsHide: true
    }) as string
  } finally {
    recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  }
}
