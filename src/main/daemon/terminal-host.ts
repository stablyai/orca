import { Session } from './session'
import { normalizePtySize } from './daemon-pty-size'
import { shellPathSupportsPtyStartupBarrier } from './shell-ready'
import { resolveProcessCwd } from '../providers/process-cwd'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  SessionNotFoundError,
  type SessionInfo,
  type TakePendingOutputResult,
  type TerminalSnapshot
} from './types'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import { shutdownTerminalHostSessions } from './terminal-host-session-shutdown'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { resolveWslSessionContext } from './wsl-session-context'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'

export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'
export type { TerminalHostOptions } from './terminal-host-options'

const DEFAULT_MAX_TOMBSTONES = 1000

export class TerminalHost {
  private sessions = new Map<string, Session>()
  private sessionTeardown = new TerminalSessionTeardown(this.sessions)
  private killedTombstones = new Map<string, number>()
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private maxTombstones: number
  private creationFenced = false
  private disposePromise: Promise<void> | null = null

  constructor(opts: TerminalHostOptions) {
    this.spawnSubprocess = opts.spawnSubprocess
    this.onFinalCheckpoint = opts.onFinalCheckpoint
    this.maxTombstones = opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES
  }

  /**
   * Creates a terminal session or attaches to an existing live one.
   *
   * Startup commands are written through stdin only when the subprocess did not
   * already deliver them through shell launch arguments.
   */
  async createOrAttach(opts: CreateOrAttachOptions): Promise<CreateOrAttachResult> {
    if (this.creationFenced) {
      throw new Error('Terminal host is shutting down')
    }
    const existing = this.sessions.get(opts.sessionId)

    // Why: async descendant capture must finish before attach/recreate, or we hand out a doomed session.
    if (this.sessionTeardown.get(opts.sessionId) || existing?.isTerminating) {
      throw new SessionNotFoundError(opts.sessionId)
    }

    if (existing && existing.isAlive && !existing.isTerminating) {
      const snapshot = existing.getSnapshot()
      existing.detachAllClients()
      const token = existing.attachClient(opts.streamClient)
      return {
        isNew: false,
        snapshot,
        pid: existing.pid,
        shellState: existing.shellState,
        ...getDaemonSessionResultMetadata(existing),
        attachToken: token
      }
    }

    if (existing?.isAlive && existing.isTerminating) {
      // Why: replacing a SIGKILLed-but-unreaped child would leak its native handles and hide two generations under one id.
      throw new Error(`Session "${opts.sessionId}" is terminating`)
    }

    if (existing) {
      existing.dispose()
      this.sessions.delete(opts.sessionId)
    }

    // Clear tombstone if re-creating a killed session
    this.killedTombstones.delete(opts.sessionId)
    const size = normalizePtySize(opts.cols, opts.rows)
    const wslDistro = resolveWslSessionContext(opts)?.distro

    const subprocess = this.spawnSubprocess({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      command: opts.command,
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation
    })

    // Why: the pre-spawn flag goes stale if spawn fell back to a shell (e.g. /bin/sh) that never emits the ready marker.
    const shellReadySupported =
      (opts.shellReadySupported ?? false) &&
      (subprocess.shellPath === undefined ||
        shellPathSupportsPtyStartupBarrier(subprocess.shellPath))

    const session = new Session({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      terminalHandle: opts.env?.ORCA_TERMINAL_HANDLE,
      launchAgent: opts.launchAgent,
      subprocess,
      shellReadySupported,
      historySeed: opts.historySeed,
      ...(opts.startupIngress ? { startupIngress: opts.startupIngress } : {}),
      wslDistro,
      // Why: reap the dead session (dispose emulator + drop from map) on subprocess exit, not at daemon shutdown.
      onExit: () => this.reapSession(opts.sessionId),
      ...(opts.shellReadyTimeoutMs !== undefined
        ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
        : {})
    })

    this.sessions.set(opts.sessionId, session)

    const token = session.attachClient(opts.streamClient)

    if (opts.command && !subprocess.startupCommandDeliveredInShellArgs) {
      // Why: startup commands must run inside the long-lived interactive shell the daemon keeps for the pane.
      // Why CR on Windows: PSReadLine/cmd.exe submit on CR; a bare LF leaves it unsubmitted (POSIX accepts CR via ICRNL).
      const submit = process.platform === 'win32' ? '\r' : '\n'
      // Why: bracketed-paste only for Orca-wrapped bash/zsh (== shell-ready supported); other shells use the raw submit path.
      session.write(
        buildStartupCommandSubmission(opts.command, {
          submit,
          bracketedPasteSafe: shellReadySupported
        })
      )
    }

    return {
      isNew: true,
      snapshot: null,
      pid: subprocess.pid,
      shellState: session.shellState,
      ...getDaemonSessionResultMetadata(session),
      attachToken: token
    }
  }

  write(sessionId: string, data: string): void {
    this.getAliveSession(sessionId).write(data)
  }

  closeStartupQueryAuthority(sessionId: string): number {
    return this.getAliveSession(sessionId).closeStartupQueryAuthority()
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getAliveSession(sessionId).resize(cols, rows)
  }

  // Why null-not-throw (unlike write/resize): pause/resume are best-effort hints against a session that may have exited.
  pauseProducer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return
    }
    session.pauseProducer()
  }

  resumeProducer(sessionId: string): void {
    this.sessions.get(sessionId)?.resumeProducer()
  }

  kill(sessionId: string, opts: { immediate?: boolean } = {}): Promise<void> {
    const pending = this.sessionTeardown.get(sessionId)
    if (pending) {
      return Promise.resolve(
        opts.immediate ? this.sessionTeardown.requestImmediate(sessionId) : pending
      )
    }
    const session = this.getAliveSession(sessionId)
    const killed = this.sessionTeardown.killSession(sessionId, session, opts.immediate === true)
    this.recordTombstone(sessionId)
    return Promise.resolve(killed)
  }

  // Why: dispose a dead session's emulator so exited terminals don't pin ~5000 rows of scrollback for the daemon's life.
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    this.sessions.delete(sessionId)
  }

  signal(sessionId: string, sig: string): void {
    this.getAliveSession(sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    const session = this.sessions.get(sessionId)
    session?.detachClient(token)
  }

  async getCwd(sessionId: string): Promise<string | null> {
    const session = this.getAliveSession(sessionId)
    const tracked = session.getCwd()
    if (tracked) {
      return tracked
    }
    // Why: emulator cwd stays null (Orca rcfiles emit OSC 133 not OSC 7), so fall back to the live process cwd.
    const resolved = await resolveProcessCwd(session.pid)
    return resolved || null
  }

  // Why: null-not-throw — fetched for the tab-bar icon, so a vanished pane should quietly yield "no agent".
  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  async confirmForegroundProcess(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.confirmForegroundProcess()
  }

  clearScrollback(sessionId: string): void {
    this.getAliveSession(sessionId).clearScrollback()
  }

  // Why: null-not-throw (unlike getAliveSession) — checkpoint is best-effort against a session that may have just exited.
  getSnapshot(sessionId: string, opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getSnapshot(opts)
  }

  // Why: scan-authority handoff seed (null-not-throw like getSnapshot) — emulator's dangling incomplete escape at the stream position.
  getPartialEscapeTailAnsi(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return ''
    }
    return session.getPartialEscapeTailAnsi()
  }

  // Why: renderer diffs this against xterm to detect a dropped/coerced daemon-side resize; null-not-throw like getSnapshot.
  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getAppliedSize()
  }

  // Why: null-not-throw like getSnapshot — incremental checkpoints are best-effort against a just-exited session.
  takePendingOutput(
    sessionId: string,
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.takePendingOutput(includeSnapshot, opts)
  }

  isKilled(sessionId: string): boolean {
    return this.killedTombstones.has(sessionId)
  }

  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = []
    for (const [, session] of this.sessions) {
      if (!session.isAlive) {
        continue
      }
      const size = session.getAppliedSize()
      result.push({
        sessionId: session.sessionId,
        state: session.state,
        shellState: session.shellState,
        isAlive: true,
        ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
        pid: session.pid,
        cwd: session.getCwd(),
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        createdAt: 0
      })
    }
    return result
  }

  dispose(): Promise<void> {
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    const disposePromise = this.disposeSessions()
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Why: keep failed native owners retryable on a later shutdown request.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }

  private async disposeSessions(): Promise<void> {
    await shutdownTerminalHostSessions(this.sessions, this.onFinalCheckpoint)
    this.killedTombstones.clear()
  }

  private getAliveSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      throw new SessionNotFoundError(sessionId)
    }
    return session
  }

  private recordTombstone(sessionId: string): void {
    this.killedTombstones.delete(sessionId)
    this.killedTombstones.set(sessionId, Date.now())

    if (this.killedTombstones.size > this.maxTombstones) {
      const oldest = this.killedTombstones.keys().next().value
      if (oldest) {
        this.killedTombstones.delete(oldest)
      }
    }
  }
}
