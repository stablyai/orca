import type * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'
import { assignHostProcessToKillOnCloseJob } from '../../windows/windows-pty-job'

import { canUseBunPty, spawnBunPty } from './bun-pty-process'

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
}

type NativePtyRuntime = {
  canUseBunPty: typeof canUseBunPty
  spawnBunPty: typeof spawnBunPty
}

/** Walks the Windows PowerShell -> cmd.exe fallback chain when ConPTY rejects the primary shell. */
export async function spawnNativeDaemonPty(
  args: {
    shellPath: string
    shellArgs: string[]
    spawnCwd: string
    env: Record<string, string>
    cols: number
    rows: number
    windowsFallbackAttempts: WindowsShellSpawnAttempt[]
    onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
  },
  runtime: NativePtyRuntime = { canUseBunPty, spawnBunPty }
): Promise<SpawnedDaemonPty> {
  let reportsChildExitStatus = true
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<pty.IPty> => {
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    if (runtime.canUseBunPty()) {
      const proc = runtime.spawnBunPty({
        file: wrapped.file,
        args: wrapped.args,
        cwd,
        env: args.env,
        cols: args.cols,
        rows: args.rows
      })
      args.onMacosTccSpawnStrategy?.(wrapped.file === shellPath ? 'direct' : 'wrapped')
      return proc
    }
    const nodePty = await loadNodePty()
    // Why: children inherit job membership, so the host job must exist before the first Windows PTY.
    if (process.platform === 'win32') {
      assignHostProcessToKillOnCloseJob()
    }
    const proc = nodePty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
      // Why: bundled ConPTY has the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    args.onMacosTccSpawnStrategy?.(wrapped.file === shellPath ? 'direct' : 'wrapped')
    return proc
  }

  try {
    const process_ = await spawnAt(args.shellPath, args.shellArgs, args.spawnCwd)
    return {
      process: process_,
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus
    }
  } catch (primaryErr) {
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const process = await spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus
        }
      } catch {
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}
