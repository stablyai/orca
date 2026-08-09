import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { DebugAdapterConfig } from '../../shared/debug-session-types'
import { buildEncodedWslBashCommand, quoteBashString } from '../wsl-bash-command'
import { buildPosixExecCommandLine } from './debug-adapter-posix-command-line'

export type DebugAdapterProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(): void
}

/**
 * Spawns a debug adapter process and hands back raw stdio streams for
 * `DapClient` to frame DAP messages over. Deliberately narrower than
 * `IPtyProvider` (`src/main/providers/pty-provider-contract.ts`) — no
 * `cols`/`rows`/`resize`, no ANSI scrollback, just a plain child process.
 */
export type DebugAdapterProcessHost = {
  spawn(config: DebugAdapterConfig): Promise<DebugAdapterProcess>
}

/**
 * The command/args actually handed to `child_process.spawn`. On a Windows
 * host debugging a worktree that lives inside WSL — the case
 * `resolveLocalProjectRuntimeForWorktreeId`
 * (`src/main/local-project-runtime-resolution.ts`) resolves as `kind:
 * 'wsl'` — cwd/env are folded into the posix command line instead of
 * `spawn`'s options, since those only apply to the Windows-side `wsl.exe`
 * process, not the distro it launches into.
 */
export function resolveSpawnTarget(
  config: DebugAdapterConfig,
  wslDistro: string | undefined
): { command: string; args: string[]; cwd?: string; env?: Record<string, string> } {
  if (!wslDistro) {
    return config
  }
  const posixCommand = buildPosixExecCommandLine(config, quoteBashString)
  return {
    command: 'wsl.exe',
    args: ['-d', wslDistro, '--', 'bash', '-lc', buildEncodedWslBashCommand(posixCommand)]
  }
}

export class LocalDebugAdapterProcessHost implements DebugAdapterProcessHost {
  constructor(private readonly wslDistro?: string) {}

  async spawn(config: DebugAdapterConfig): Promise<DebugAdapterProcess> {
    const { command, args, cwd, env } = resolveSpawnTarget(config, this.wslDistro)
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill()
      throw new Error(`Failed to spawn debug adapter "${config.command}": stdio pipes unavailable`)
    }

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => {
        child.kill()
      }
    }
  }
}
