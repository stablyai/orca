import type { SpawnOptions } from 'node:child_process'
import { execNativeFileSync } from '@orca/process-host/native-process-spawn'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { resolveCommand } from './host-routing/wsl-command-resolution'

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
  if (resolved.wsl) {
    // Host Git only: a WSL path would make this a synchronous wsl.exe that can boot the distro.
    throw new Error('Synchronous Git cannot run in a WSL folder. Use asynchronous Git for it.')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A BufferEncoding is always supplied, so execFileSync returns text.
  return execNativeFileSync(
    resolved.binary,
    resolved.args,
    {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      env: untranslatedGitOutputEnv(),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS,
      windowsHide: true
    },
    recordSubprocessSpawn
  ) as string
}
