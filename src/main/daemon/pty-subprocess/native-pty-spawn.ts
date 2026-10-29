import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import type * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'
import { assignHostProcessToKillOnCloseJob } from '../../windows/windows-pty-job'
import { wrapPtySpawnInTerminalScope } from '../terminal-scopes-runtime'
import { spawnConptyWithInputReader, type ConptyStartupEvents } from './conpty-startup-input-reader'

async function loadNodePty(): Promise<typeof pty> {
  return import('node-pty')
}
export type SpawnedDaemonPty = {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
  /** Windows: output and exit seen while confirming ConPTY reads input; claim before subscribing. */
  claimStartupEvents?: () => ConptyStartupEvents
}

type SpawnedNativePty = { proc: pty.IPty; claimStartupEvents?: () => ConptyStartupEvents }

export async function spawnNativeDaemonPty(args: {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  env: Record<string, string>
  cols: number
  rows: number
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  /** The primary shell's argv is Orca's interactive default, so a respawn cannot repeat a command. */
  primaryArgsRespawnSafe?: boolean
  signal?: AbortSignal
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}): Promise<SpawnedDaemonPty> {
  let reportsChildExitStatus = true
  const spawnOnce = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<pty.IPty> => {
    args.signal?.throwIfAborted()
    assertWslDistroAllowed(shellPath, shellArgs)
    const tcc = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    const wrapped = wrapPtySpawnInTerminalScope(tcc.file, tcc.args, args.env)
    const nodePty = await loadNodePty()
    // Establish the host job before spawning so Windows PTYs inherit membership.
    if (process.platform === 'win32') {
      assignHostProcessToKillOnCloseJob()
    }
    const proc = nodePty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: wrapped.env,
      // Bundled ConPTY provides the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
    reportsChildExitStatus = hostReportsChildExitStatus(tcc.file)
    args.onMacosTccSpawnStrategy?.(tcc.file === shellPath ? 'direct' : 'wrapped')
    return proc
  }
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string,
    respawnSafe: boolean
  ): Promise<SpawnedNativePty> => {
    if (process.platform !== 'win32') {
      return { proc: await spawnOnce(shellPath, shellArgs, cwd) }
    }
    return spawnConptyWithInputReader(() => spawnOnce(shellPath, shellArgs, cwd), {
      label: shellPath,
      respawnSafe,
      ...(args.signal ? { signal: args.signal } : {})
    })
  }

  try {
    const spawned = await spawnAt(
      args.shellPath,
      args.shellArgs,
      args.spawnCwd,
      args.primaryArgsRespawnSafe === true
    )
    return {
      process: spawned.proc,
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus,
      ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
    }
  } catch (primaryErr) {
    args.signal?.throwIfAborted()
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const spawned = await spawnAt(
          attempt.shellPath,
          attempt.shellArgs,
          attempt.effectiveCwd,
          args.primaryArgsRespawnSafe === true && !attempt.startupCommandDeliveredInShellArgs
        )
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process: spawned.proc,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus,
          ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
        }
      } catch {
        args.signal?.throwIfAborted()
      }
    }
    throw primaryErr
  }
}
