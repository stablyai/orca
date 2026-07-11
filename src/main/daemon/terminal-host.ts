import { Session, type SubprocessHandle } from './session'
import { normalizePtySize } from './daemon-pty-size'
import { resolveProcessCwd } from '../providers/process-cwd'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import type { SessionInfo, TakePendingOutputResult, TerminalSnapshot } from './types'
import { SessionNotFoundError } from './types'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

const DEFAULT_MAX_TOMBSTONES = 1000

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    shellOverride?: string
    terminalWindowsWslDistro?: string | null
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  }) => SubprocessHandle
  // Why: on graceful shutdown, the host writes final checkpoints for all live
  // sessions before killing them. This bypasses the RPC round-trip — the daemon
  // writes checkpoints in-process, guaranteeing completion before teardown.
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
  // Why: production keeps a large cap, but tests need a small deterministic cap
  // without spawning thousands of full terminal sessions.
  maxTombstones?: number
}

export class TerminalHost {
  private sessions = new Map<string, Session>()
  private killedTombstones = new Map<string, number>()
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private maxTombstones: number

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
    const existing = this.sessions.get(opts.sessionId)

    // Why: a session that has been asked to terminate (kill() called but the
    // subprocess hasn't exited yet) must not be reattached. Reattaching would
    // hand the caller a handle that races with the in-flight exit, and any
    // subsequent operation (write/kill/resize) would fail once the subprocess
    // finally exits. Treat terminating sessions the same as fully-exited ones.
    if (existing && existing.isAlive && !existing.isTerminating) {
      const snapshot = existing.getSnapshot()
      existing.detachAllClients()
      const token = existing.attachClient(opts.streamClient)
      return {
        isNew: false,
        snapshot,
        pid: existing.pid,
        shellState: existing.shellState,
        ...(existing.launchAgent ? { launchAgent: existing.launchAgent } : {}),
        ...(existing.historySeeded !== undefined ? { historySeeded: existing.historySeeded } : {}),
        attachToken: token
      }
    }

    // Clean up dead session if present
    if (existing) {
      existing.dispose()
      this.sessions.delete(opts.sessionId)
    }

    // Clear tombstone if re-creating a killed session
    this.killedTombstones.delete(opts.sessionId)
    const size = normalizePtySize(opts.cols, opts.rows)

    const subprocess = this.spawnSubprocess({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      command: opts.command,
      startupCommandDelivery: opts.startupCommandDelivery,
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation
    })

    const session = new Session({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      terminalHandle: opts.env?.ORCA_TERMINAL_HANDLE,
      launchAgent: opts.launchAgent,
      subprocess,
      shellReadySupported: opts.shellReadySupported ?? false,
      historySeed: opts.historySeed,
      // Why: reap the dead session (dispose emulator + drop from the map) the
      // moment its subprocess exits, instead of retaining it for the daemon's
      // lifetime. Nothing reads a dead session's emulator (getSnapshot/
      // takePendingOutput/listSessions all skip !isAlive sessions).
      onExit: () => this.reapSession(opts.sessionId),
      ...(opts.shellReadyTimeoutMs !== undefined
        ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
        : {})
    })

    this.sessions.set(opts.sessionId, session)

    const token = session.attachClient(opts.streamClient)

    if (opts.command && !subprocess.startupCommandDeliveredInShellArgs) {
      // Why: startup commands must run inside the long-lived interactive shell
      // the daemon keeps for the pane. Session.write() handles the shell-ready
      // barrier for supported shells and falls back to an immediate write for
      // unsupported ones.
      // Why CR on Windows: PowerShell's PSReadLine and cmd.exe submit the line
      // on CR (`\r`); a bare LF leaves the command typed but unsubmitted, so
      // the user would need to press Enter after Orca launches the agent or
      // setup script. POSIX shells accept CR as Enter under ICRNL.
      const submit = process.platform === 'win32' ? '\r' : '\n'
      // Why: multiline startup prompts are pasted literally via bracketed paste
      // only for Orca-wrapped bash/zsh, which is exactly when the shell-ready
      // barrier is supported; other shells keep the raw submit path.
      session.write(
        buildStartupCommandSubmission(opts.command, {
          submit,
          bracketedPasteSafe: opts.shellReadySupported ?? false
        })
      )
    }

    return {
      isNew: true,
      snapshot: null,
      pid: subprocess.pid,
      shellState: session.shellState,
      ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
      ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
      attachToken: token
    }
  }

  write(sessionId: string, data: string): void {
    this.getAliveSession(sessionId).write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getAliveSession(sessionId).resize(cols, rows)
  }

  // Why null-not-throw (unlike write/resize): pause/resume are best-effort
  // flow-control hints; a session that exited while the notify was in flight
  // must not surface an error or a synthetic exit.
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

  kill(sessionId: string, opts: { immediate?: boolean } = {}): void {
    const session = this.getAliveSession(sessionId)
    this.recordTombstone(sessionId)
    if (opts.immediate) {
      session.forceKillAndDisposeSubprocess()
      // Why: the immediate path tears down synchronously without firing the
      // session's onExit hook, so reap it here. The graceful path below funnels
      // through Session.handleSubprocessExit -> onExit -> reapSession.
      this.reapSession(sessionId)
      return
    }
    session.kill()
  }

  // Why: dispose a dead session's headless emulator and drop it from the map so
  // exited terminals don't pin ~5000 rows of scrollback for the daemon's life.
  // No-ops on live sessions (a live session must never be disposed here) and on
  // already-reaped/unknown ids. Wired as the Session onExit hook and also called
  // on the immediate-kill path.
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
    // Why: the emulator's cwd is null until the shell emits OSC 7. Orca's
    // bash/zsh rcfiles ship with OSC 133 markers but not OSC 7, so the
    // tracked value stays null through the entire session for most users.
    // Fall back to the live process cwd via /proc/<pid>/cwd (Linux) or
    // lsof (macOS). Matches the LocalPtyProvider.getCwd fallback.
    const resolved = await resolveProcessCwd(session.pid)
    return resolved || null
  }

  // Why: returns null (not throws) for a dead/missing session — this is fetched
  // for the tab-bar icon, so a vanished pane should quietly yield "no agent".
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

  // Why: unlike getAliveSession (which throws), this returns null for dead/missing
  // sessions. Checkpoint is best-effort — a session that exited between the timer
  // firing and the RPC arriving should not throw.
  getSnapshot(sessionId: string, opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getSnapshot(opts)
  }

  // Why: scan-authority handoff seed (null-not-throw like getSnapshot) — the
  // emulator's dangling incomplete escape at the current stream position.
  getPartialEscapeTailAnsi(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return ''
    }
    return session.getPartialEscapeTailAnsi()
  }

  // Why: read-only readback of the size the PTY actually applied (null-not-throw
  // like getSnapshot). The renderer compares this against xterm to detect a
  // resize that was dropped/coerced daemon-side and re-assert it.
  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getAppliedSize()
  }

  // Why: same null-not-throw semantics as getSnapshot — incremental
  // checkpoints are best-effort against sessions that may have just exited.
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

  dispose(): void {
    // Why: write final checkpoints before killing sessions so graceful shutdown
    // has zero data loss. The checkpoint callback writes synchronously to disk.
    if (this.onFinalCheckpoint) {
      for (const [sessionId, session] of this.sessions) {
        if (!session.isAlive) {
          continue
        }
        const take = session.takePendingOutput(true, { teardownSnapshot: true })
        if (take?.snapshot) {
          try {
            this.onFinalCheckpoint(sessionId, take.snapshot, take.records)
          } catch {
            // Best-effort — don't block shutdown
          }
        }
      }
    }

    for (const [, session] of this.sessions) {
      session.detachAllClients()
      // Why: live-vs-exited is load-bearing. For LIVE sessions we use
      // forceKillAndDisposeSubprocess (SIGKILL + destroy) to reap stubborn
      // children AND release the ptmx fd on the same tick, bypassing the 5s
      // KILL_TIMEOUT_MS fallback that would otherwise outlive the daemon
      // process. For sessions that have already exited but are still in the
      // map, SIGKILL would target a reaped pid — on POSIX that pid can be
      // recycled to an unrelated process, so we MUST only release the fd via
      // disposeSubprocess() (destroy without kill). See docs/fix-pty-fd-leak.md.
      if (session.isAlive) {
        session.forceKillAndDisposeSubprocess()
      } else {
        session.disposeSubprocess()
      }
    }
    this.sessions.clear()
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
