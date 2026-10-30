import type { PtyCreationDisposition } from '../../../shared/claimed-agent-pty-owner'
import type { TerminalCreationWork } from '../terminal-creation-work'
import { createDaemonPtyPhysicalOwner, type DaemonPtyPhysicalOwner } from './subprocess-handle'
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

export type DisposableNativePty = pty.IPty & {
  destroy?: () => void
  signalProcess?: (signal: string) => void
  // node-pty emits these when its master stream retires; writes then become silent no-ops.
  on?: (event: 'close' | 'error', listener: (error?: unknown) => void) => void
  // False once node-pty's _close() retired the master; Windows never emits 'close' for that.
  _writable?: boolean
}

export type SpawnedDaemonPty = {
  process: pty.IPty
  physicalOwner?: DaemonPtyPhysicalOwner
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
  /** Windows: output seen while confirming ConPTY reads input; claim before subscribing. */
  claimStartupEvents?: () => ConptyStartupEvents
}

type SpawnedNativePty = {
  proc: pty.IPty
  physicalOwner: DaemonPtyPhysicalOwner
  claimStartupEvents?: () => ConptyStartupEvents
}

export async function spawnNativeDaemonPty(args: {
  creationWork?: TerminalCreationWork
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
  assertCreateAllowed?: () => void
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}): Promise<SpawnedDaemonPty> {
  let reportsChildExitStatus = true
  let unpublishedOwner: DaemonPtyPhysicalOwner | undefined
  const spawnOnce = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<{ proc: pty.IPty; physicalOwner: DaemonPtyPhysicalOwner }> => {
    args.signal?.throwIfAborted()
    assertWslDistroAllowed(shellPath, shellArgs)
    const tcc = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    const wrapped = wrapPtySpawnInTerminalScope(tcc.file, tcc.args, args.env)
    const nodePty = await loadNodePty()
    // Establish the host job before spawning so Windows PTYs inherit membership.
    if (process.platform === 'win32') {
      assignHostProcessToKillOnCloseJob()
    }
    args.signal?.throwIfAborted()
    args.assertCreateAllowed?.()
    const attempt = Promise.withResolvers<PtyCreationDisposition>()
    args.creationWork?.join(attempt.promise)
    let proc: pty.IPty
    try {
      proc = nodePty.spawn(wrapped.file, wrapped.args, {
        name: args.env.TERM ?? 'xterm-256color',
        cols: args.cols,
        rows: args.rows,
        cwd,
        env: wrapped.env,
        // Bundled ConPTY provides the wrap-marker behavior xterm expects.
        ...(process.platform === 'win32' ? { useConptyDll: true } : {})
      })
    } catch (error) {
      attempt.resolve({ kind: 'failed', completion: Promise.resolve() })
      throw error
    }
    const physical = createDaemonPtyPhysicalOwner(proc)
    unpublishedOwner = physical
    attempt.resolve({
      kind: 'physical',
      completion: physical.completion,
      exitCode: physical.exitCode,
      recover: physical.recover
    })
    physical.observeExit()
    reportsChildExitStatus = hostReportsChildExitStatus(tcc.file)
    try {
      args.onMacosTccSpawnStrategy?.(tcc.file === shellPath ? 'direct' : 'wrapped')
    } catch {
      /* Diagnostics cannot revoke an owned child. */
    }
    return { proc, physicalOwner: physical }
  }
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string,
    respawnSafe: boolean
  ): Promise<SpawnedNativePty> => {
    if (process.platform !== 'win32') {
      return await spawnOnce(shellPath, shellArgs, cwd)
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
      physicalOwner: spawned.physicalOwner,
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus,
      ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
    }
  } catch (primaryErr) {
    // A returned predecessor stays owned until exit, including failed observer/startup setup.
    await unpublishedOwner?.recover()
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
          physicalOwner: spawned.physicalOwner,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus,
          ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
        }
      } catch {
        await unpublishedOwner?.recover()
        args.signal?.throwIfAborted()
      }
    }
    throw primaryErr
  }
}
