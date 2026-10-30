import type { EventEmitter } from 'node:events'
import type { WindowsProcessEvidence } from '../daemon/daemon-incarnation-evidence-types'
import type { WslDistroHolderRecord } from './wsl-distro-holder-record'

/** Holder liveness, in the execution-host vocabulary: lookup failure is never `exited`. */
export type WslDistroHolderState = 'live' | 'exited' | 'unverifiable'

export type WslDistroHolderEnsureResult =
  | { outcome: 'adopted'; record: WslDistroHolderRecord }
  | { outcome: 'spawned'; record: WslDistroHolderRecord }
  /** The recorded holder could not be checked; kept rather than doubled (it may be live). */
  | { outcome: 'unverifiable'; record: WslDistroHolderRecord }

/** Minimal child lifecycle: spawn/error/exit, PID and unref. */
export type WslDistroHolderChild = EventEmitter & { readonly pid?: number; unref(): void }

export type WslDistroHolderAdoption = { distro: string; state: WslDistroHolderState }

/**
 * Uninstall only: nothing will ever release a holder left now, so its marker and distro on the
 * command line prove it ours without a start time, and an unreadable table is read once more.
 */
export type WslDistroHolderReleaseOptions = { forUninstall?: boolean }

export type WslDistroHolderDependencies = {
  userDataPath: string
  /** Test seam; production spawns `wsl.exe` detached through process-host. */
  spawnHolder?: (distro: string) => WslDistroHolderChild
  queryProcess?: (pid: number) => Promise<WindowsProcessEvidence>
  killProcess?: (pid: number) => void
  /** Must never boot a distro: `wsl --list --running` only. */
  listRunningDistros?: () => Promise<string[]>
  /** Wall clock, only for the record's `startedAtMs` stamp. */
  now?: () => number
  /** Deadlines and the unverifiable bound; monotonic so a clock jump moves neither. */
  monotonicNow?: () => number
  /** A holder this process spawned exited (code 1 when its distro stopped); liveness re-checks. */
  onHolderExit?: (
    distro: string,
    exit: { code: number | null; signal: NodeJS.Signals | null }
  ) => void
  /** A holder's code 1 means its distro stopped: later background reads must re-read (E9). */
  noteMayHaveStopped?: (distro: string) => void
  sleep?: (ms: number) => Promise<void>
  /** How long a spawned holder has to bring its distro up (a cold boot can take ~15 s). */
  bootTimeoutMs?: number
}

export type WslDistroHolder = {
  /**
   * User-initiated only: the one path allowed to boot a stopped distro. Background callers pass
   * `requireRunning`, re-read right before a spawn, so a distro that stopped is never booted (E9).
   */
  ensureHeld(
    distro: string,
    options?: { requireRunning?: () => Promise<boolean> }
  ): Promise<WslDistroHolderEnsureResult>
  /** Startup: keep holders a previous Orca left running, drop records that are provably stale. */
  adoptHolders(): Promise<WslDistroHolderAdoption[]>
  /** Explicit stop only; the distro then stops on WSL's schedule once nothing else runs in it. */
  release(distro: string): Promise<WslDistroHolderState>
  /** Every recorded holder (uninstall, hosts turned off); kills only verified holders. */
  releaseAll(options?: WslDistroHolderReleaseOptions): Promise<WslDistroHolderAdoption[]>
  holderState(distro: string): Promise<WslDistroHolderState>
}
