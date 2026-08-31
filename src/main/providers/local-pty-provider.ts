import type * as pty from 'node-pty'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from './types'
import {
  confirmLocalPtyForegroundProcess,
  confirmLocalPtyShellForeground,
  getLocalPtyForegroundProcess,
  hasLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import {
  advanceLoadGeneration,
  clearPtyState,
  pendingLocalPtySpawns,
  ptyProcesses,
  resetLoadGeneration,
  type DataCallback,
  type ExitCallback
} from './local-pty-provider-state'
import {
  clearLocalPtyBuffer,
  closeLocalPtyStartupQueryAuthority,
  getDefaultLocalPtyShell,
  getLocalPtyAppliedSize,
  getLocalPtyCwd,
  getLocalPtyProcess,
  getLocalPtyProfiles,
  listLocalPtyProcesses,
  onLocalPtyData,
  onLocalPtyExit,
  pauseLocalPtyProducer,
  resizeLocalPty,
  resumeLocalPtyProducer,
  sendLocalPtySignal,
  writeLocalPty
} from './local-pty-session-operations'
import { spawnLocalPty } from './local-pty-spawn'
import { cancelAllPendingLocalPtySpawns } from './local-pty-spawn-state'
import { killAllLocalPtys, killOrphanedLocalPtys, shutdownLocalPty } from './local-pty-termination'

export type { LocalPtyProviderOptions } from './local-pty-provider-types'
export {
  LOCAL_PTY_FORCE_KILL_RETRY_MS,
  LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS,
  LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS
} from './local-pty-termination'

export class LocalPtyProvider implements IPtyProvider {
  private opts: LocalPtyProviderOptions

  constructor(opts: LocalPtyProviderOptions = {}) {
    this.opts = opts
  }

  /** Reconfigure the provider with new hooks (e.g. after window re-creation). */
  configure(opts: LocalPtyProviderOptions): void {
    this.opts = opts
  }

  /**
   * Spawns or reattaches a local PTY session for the renderer process.
   *
   * Windows launches can pre-deliver startup commands in argv, so the stdin fallback only runs when needed.
   */
  spawn(args: PtySpawnOptions): Promise<PtySpawnResult> {
    return spawnLocalPty(args, () => this.opts)
  }

  // Local PTYs are always attached -- no-op. Remote providers use this to resubscribe.
  async attach(_id: string): Promise<void> {}
  hasPty(id: string): boolean {
    return ptyProcesses.has(id)
  }
  write(id: string, data: string): boolean {
    return writeLocalPty(id, data)
  }
  resize(id: string, cols: number, rows: number): void {
    resizeLocalPty(id, cols, rows)
  }

  pauseProducer(id: string): void {
    pauseLocalPtyProducer(id)
  }

  resumeProducer(id: string): void {
    resumeLocalPtyProducer(id)
  }

  getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return getLocalPtyAppliedSize(id)
  }

  shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    return shutdownLocalPty(id, opts)
  }

  sendSignal(id: string, signal: string): Promise<void> {
    return sendLocalPtySignal(id, signal)
  }

  getCwd(id: string): Promise<string> {
    return getLocalPtyCwd(id)
  }
  async getInitialCwd(_id: string): Promise<string> {
    return ''
  }
  clearBuffer(id: string): Promise<void> {
    return clearLocalPtyBuffer(id)
  }
  closeStartupQueryAuthority(id: string): number {
    return closeLocalPtyStartupQueryAuthority(id)
  }
  acknowledgeDataEvent(_id: string, _charCount: number): void {
    /* no flow control for local */
  }

  hasChildProcesses(id: string): Promise<boolean> {
    return hasLocalPtyChildProcesses(id)
  }

  getForegroundProcess(id: string): Promise<string | null> {
    return getLocalPtyForegroundProcess(id)
  }

  confirmForegroundProcess(id: string): Promise<string | null> {
    return confirmLocalPtyForegroundProcess(id)
  }

  confirmShellForeground(id: string): Promise<boolean> {
    return confirmLocalPtyShellForeground(id)
  }

  async serialize(_ids: string[]): Promise<string> {
    return '{}'
  }
  async revive(_state: string): Promise<void> {
    /* re-spawning handles local revival */
  }

  listProcesses(): Promise<PtyProcessInfo[]> {
    return listLocalPtyProcesses()
  }

  getDefaultShell(): Promise<string> {
    return getDefaultLocalPtyShell(() => this.opts)
  }

  getProfiles(): Promise<{ name: string; path: string }[]> {
    return getLocalPtyProfiles()
  }

  onData(callback: DataCallback): () => void {
    return onLocalPtyData(callback)
  }

  // Local PTYs don't replay -- this is for remote reconnection
  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: ExitCallback): () => void {
    return onLocalPtyExit(callback)
  }

  // ─── Local-only helpers (not part of IPtyProvider interface) ───────

  /** Kill orphaned PTYs from previous page loads. */
  killOrphanedPtys(currentGeneration: number): { id: string }[] {
    return killOrphanedLocalPtys(currentGeneration)
  }

  /** Advance the load generation counter (called on renderer reload). */
  advanceGeneration(): number {
    return advanceLoadGeneration()
  }

  /** Get a writable reference to a PTY (for runtime controller). */
  getPtyProcess(id: string): pty.IPty | undefined {
    return getLocalPtyProcess(id)
  }

  /** Kill all in-process local PTYs. Call on app quit. */
  killAll(): void {
    killAllLocalPtys()
  }
}

export function _resetLocalPtyProviderStateForTest(): void {
  cancelAllPendingLocalPtySpawns()
  pendingLocalPtySpawns.clear()
  for (const id of ptyProcesses.keys()) {
    clearPtyState(id)
  }
  resetLoadGeneration()
}
