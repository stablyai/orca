import { Session, type SubprocessHandle } from './session'
import { normalizePtySize } from './daemon-pty-size'
import type { SessionInfo, TerminalSnapshot, ShellReadyState } from './types'
import { SessionNotFoundError } from './types'

const MAX_TOMBSTONES = 1000

export type CreateOrAttachOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  /** Explicit shell the renderer asked for (e.g. 'wsl.exe' for "New WSL
   *  terminal" from the "+" menu). Forwarded to the subprocess spawner so the
   *  daemon path honors per-tab shell selection the same way LocalPtyProvider
   *  does. */
  shellOverride?: string
  shellReadySupported?: boolean
  streamClient: { onData: (data: string) => void; onExit: (code: number) => void }
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  attachToken: symbol
}

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
  }) => SubprocessHandle
  // Why: on graceful shutdown, the host writes final checkpoints for all live
  // sessions before killing them. This bypasses the RPC round-trip — the daemon
  // writes checkpoints in-process, guaranteeing completion before teardown.
  onFinalCheckpoint?: (sessionId: string, snapshot: TerminalSnapshot) => void
}

export class TerminalHost {
  private sessions = new Map<string, Session>()
  private killedTombstones = new Map<string, number>()
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']

  constructor(opts: TerminalHostOptions) {
    this.spawnSubprocess = opts.spawnSubprocess
    this.onFinalCheckpoint = opts.onFinalCheckpoint
  }

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
      command: opts.command,
      shellOverride: opts.shellOverride
    })

    const session = new Session({
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      subprocess,
      shellReadySupported: opts.shellReadySupported ?? false
    })

    this.sessions.set(opts.sessionId, session)

    const token = session.attachClient(opts.streamClient)

    if (opts.command) {
      // Why: startup commands must run inside the long-lived interactive shell
      // the daemon keeps for the pane. Session.write() handles the shell-ready
      // barrier for supported shells and falls back to an immediate write for
      // unsupported ones.
      // Why CR on Windows: PowerShell's PSReadLine and cmd.exe submit the line
      // on CR (`\r`); a bare LF leaves the command typed but unsubmitted, so
      // the user would need to press Enter after Orca launches the agent or
      // setup script. POSIX shells accept CR as Enter under ICRNL.
      const submit = process.platform === 'win32' ? '\r' : '\n'
      const endsWithSubmit = opts.command.endsWith('\r') || opts.command.endsWith('\n')
      session.write(endsWithSubmit ? opts.command : `${opts.command}${submit}`)
    }

    return {
      isNew: true,
      snapshot: null,
      pid: subprocess.pid,
      shellState: session.shellState,
      attachToken: token
    }
  }

  write(sessionId: string, data: string): void {
    this.getAliveSession(sessionId).write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getAliveSession(sessionId).resize(cols, rows)
  }

  kill(sessionId: string): void {
    const session = this.getAliveSession(sessionId)
    this.recordTombstone(sessionId)
    session.kill()
  }

  signal(sessionId: string, sig: string): void {
    this.getAliveSession(sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    const session = this.sessions.get(sessionId)
    session?.detachClient(token)
  }

  getCwd(sessionId: string): string | null {
    return this.getAliveSession(sessionId).getCwd()
  }

  clearScrollback(sessionId: string): void {
    this.getAliveSession(sessionId).clearScrollback()
  }

  // Why: unlike getAliveSession (which throws), this returns null for dead/missing
  // sessions. Checkpoint is best-effort — a session that exited between the timer
  // firing and the RPC arriving should not throw.
  getSnapshot(sessionId: string): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getSnapshot()
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
      const snapshot = session.getSnapshot()
      result.push({
        sessionId: session.sessionId,
        state: session.state,
        shellState: session.shellState,
        isAlive: true,
        pid: session.pid,
        cwd: session.getCwd(),
        cols: snapshot?.cols ?? 0,
        rows: snapshot?.rows ?? 0,
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
        const snapshot = session.getSnapshot()
        if (snapshot) {
          try {
            this.onFinalCheckpoint(sessionId, snapshot)
          } catch {
            // Best-effort — don't block shutdown
          }
        }
      }
    }

    for (const [, session] of this.sessions) {
      session.detachAllClients()
      session.kill()
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

    if (this.killedTombstones.size > MAX_TOMBSTONES) {
      const oldest = this.killedTombstones.keys().next().value
      if (oldest) {
        this.killedTombstones.delete(oldest)
      }
    }
  }
}
