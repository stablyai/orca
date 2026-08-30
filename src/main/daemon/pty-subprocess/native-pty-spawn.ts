import * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import {
  readMacosTccAttribution,
  type MacosTccSpawnStrategy
} from '../../providers/macos-tcc-spawn-attribution'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'
import { assignHostProcessToKillOnCloseJob } from '../../windows/windows-pty-job'

export type SpawnedDaemonPty = {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
}

/** Walks the Windows PowerShell -> cmd.exe fallback chain when ConPTY rejects the primary shell. */
export function spawnNativeDaemonPty(args: {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  env: Record<string, string>
  cols: number
  rows: number
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  onMacosTccSpawnStrategy?: (strategy: MacosTccSpawnStrategy) => void
}): SpawnedDaemonPty {
  let reportsChildExitStatus = true
  const spawnAt = (shellPath: string, shellArgs: string[], cwd: string): pty.IPty => {
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    // Why: children inherit job membership, so the host job must exist before the first Windows PTY.
    if (process.platform === 'win32') {
      assignHostProcessToKillOnCloseJob()
    }
    const proc = pty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
      // Why: bundled ConPTY has the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    // Why: the wrapper and the disclaim are independent — login(1) stopped isolating
    // attribution on macOS 26, so report what each one actually achieved (STA-3631).
    args.onMacosTccSpawnStrategy?.({
      wrapper: wrapped.file === shellPath ? 'direct' : 'wrapped',
      attribution: readMacosTccAttribution(proc)
    })
    return proc
  }

  try {
    const process_ = spawnAt(args.shellPath, args.shellArgs, args.spawnCwd)
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
        const process = spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
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
