import type { Session } from './session'
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
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { createOrAttachClaimedAgentSession } from './terminal-host-agent-session-claim'
import { TerminalHostAgentSessionGenerations } from './terminal-host-agent-session-generations'
import { resolveTerminalHostSessionCwd } from './terminal-host-session-cwd'
import { TerminalHostTombstones } from './terminal-host-tombstones'
import { listLiveTerminalHostSessions } from './terminal-host-session-listing'
import { createOrAttachTerminalSession } from './terminal-host-session-create'

export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'
export type { TerminalHostOptions } from './terminal-host-options'

const DEFAULT_MAX_TOMBSTONES = 1000

export class TerminalHost {
  private sessions = new Map<string, Session>()
  private sessionTeardown = new TerminalSessionTeardown(this.sessions)
  private killedTombstones: TerminalHostTombstones
  private spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private maxTombstones: number
  private creationFenced = false
  private disposePromise: Promise<void> | null = null
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionGenerations = new TerminalHostAgentSessionGenerations()

  constructor(opts: TerminalHostOptions) {
    this.spawnSubprocess = opts.spawnSubprocess
    this.onFinalCheckpoint = opts.onFinalCheckpoint
    this.maxTombstones = opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES
    this.killedTombstones = new TerminalHostTombstones(this.maxTombstones)
  }

  async createOrAttach(opts: CreateOrAttachOptions): Promise<CreateOrAttachResult> {
    return await createOrAttachClaimedAgentSession({
      options: opts,
      owners: this.agentSessionOwners,
      isLive: (owner) =>
        this.agentSessionGenerations.isCurrent(
          owner,
          Boolean(this.sessions.get(owner.ptyId)?.isAlive)
        ),
      createOrAttach: async (options) => {
        if (options.agentSessionGeneration && this.sessions.get(options.sessionId)?.isAlive) {
          throw new Error('agent_session_claim_unavailable')
        }
        return await createOrAttachTerminalSession(options, {
          sessions: this.sessions,
          sessionTeardown: this.sessionTeardown,
          killedTombstones: this.killedTombstones,
          spawnSubprocess: this.spawnSubprocess,
          creationFenced: this.creationFenced,
          onDeadSessionRemoved: (sessionId) => this.agentSessionGenerations.forget(sessionId),
          onSessionCreated: (sessionId, generation, isAlive) =>
            this.agentSessionGenerations.remember(sessionId, generation, isAlive),
          onSessionExit: (sessionId, generation) => {
            this.agentSessionOwners.release(sessionId, generation)
            this.agentSessionGenerations.forget(sessionId, generation)
            this.reapSession(sessionId)
          }
        })
      }
    })
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
    this.killedTombstones.record(sessionId)
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
    return await resolveTerminalHostSessionCwd(this.getAliveSession(sessionId))
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
    return listLiveTerminalHostSessions(this.sessions, this.agentSessionOwners)
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
}
