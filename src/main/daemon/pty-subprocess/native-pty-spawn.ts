import { PhysicalExitTracker } from '../../../shared/physical-exit-tracker'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS } from '../immediate-kill-reply-budget'
import type { TerminalSpawnAttempt } from '../terminal-spawn-attempt'
import type { TerminalProcess } from '../../../shared/terminal-process'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'

import { canUseBunPty, spawnBunPty } from './bun-pty-process'
import { WindowsBunPtySpawnUnconfirmedError } from './windows-bun-pty-spawn-receipt'

export type SpawnedDaemonPty = {
  process: TerminalProcess
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
}

export class PtySpawnCleanupError extends Error {}

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
    signal?: AbortSignal
    onSpawnAttempt?: (
      spawned: SpawnedDaemonPty,
      discardNative: () => Promise<void>
    ) => TerminalSpawnAttempt
    onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
  },
  runtime: NativePtyRuntime = { canUseBunPty, spawnBunPty }
): Promise<SpawnedDaemonPty> {
  args.signal?.throwIfAborted()
  if (!runtime.canUseBunPty()) {
    throw new Error('Terminal service requires the bundled Bun runtime')
  }
  let reportsChildExitStatus = true
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string,
    startupCommandDeliveredInShellArgs?: boolean
  ): Promise<TerminalProcess> => {
    args.signal?.throwIfAborted()
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    const proc = runtime.spawnBunPty({
      file: wrapped.file,
      args: wrapped.args,
      cwd,
      env: args.env,
      cols: args.cols,
      rows: args.rows
    })
    let attempt: TerminalSpawnAttempt | undefined
    const physicalExit = new PhysicalExitTracker()
    const exitSubscription = args.onSpawnAttempt
      ? proc.onExit(() => physicalExit.markExited())
      : undefined
    const discardNative = async (): Promise<void> => {
      proc.destroy()
      await physicalExit.waitForExit(
        IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
        () => new Error('Failed terminal spawn has not exited')
      )
      exitSubscription?.dispose()
    }
    try {
      attempt = args.onSpawnAttempt?.(
        {
          process: proc,
          shellPath,
          spawnCwd: cwd,
          reportsChildExitStatus,
          ...(startupCommandDeliveredInShellArgs === undefined
            ? {}
            : { startupCommandDeliveredInShellArgs })
        },
        discardNative
      )
      if (attempt?.failure) {
        throw attempt.failure.error
      }
      if (proc.waitForSpawn) {
        await waitForPromiseWithSignal(proc.waitForSpawn(), args.signal)
      }
      args.signal?.throwIfAborted()
    } catch (error) {
      try {
        if (attempt) {
          await attempt.discard()
          exitSubscription?.dispose()
        } else {
          proc.destroy()
        }
      } catch (cleanupError) {
        throw new PtySpawnCleanupError('Failed shell launch still owns a process', {
          cause: cleanupError
        })
      }
      throw error
    }
    exitSubscription?.dispose()
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
    if (primaryErr instanceof PtySpawnCleanupError) {
      throw primaryErr
    }
    args.signal?.throwIfAborted()
    if (process.platform !== 'win32' || primaryErr instanceof WindowsBunPtySpawnUnconfirmedError) {
      throw primaryErr
    }
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const process = await spawnAt(
          attempt.shellPath,
          attempt.shellArgs,
          attempt.effectiveCwd,
          attempt.startupCommandDeliveredInShellArgs
        )
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
      } catch (error) {
        if (error instanceof PtySpawnCleanupError) {
          throw error
        }
        args.signal?.throwIfAborted()
        if (error instanceof WindowsBunPtySpawnUnconfirmedError) {
          throw error
        }
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}
