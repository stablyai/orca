import { beginTerminalHostFencedTermination } from './terminal-host-fenced-termination'
import type { PtyFencedTerminationRequest } from '../../shared/pty-fenced-termination'
import type { Session } from './session'
import type { PtyProcessInspectionOptions } from '../providers/pty-process-inspection'
import type { SessionInfo, TakePendingOutputResult, TerminalSnapshot } from './types'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import { disposeTerminalHostSessions, killLiveSessionGroupsSync } from './terminal-host-disposal'
import { getAliveTerminalHostSession } from './terminal-host-session-access'
import { writeSessionInput } from './session-input-path'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { createOrAttachClaimedAgentSession } from './terminal-host-agent-session-claim'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import { TerminalHostAgentSessionGenerations } from './terminal-host-agent-session-generations'
import { resolveTerminalHostSessionCwd } from './terminal-host-session-cwd'
import { TerminalHostTombstones } from './terminal-host-tombstones'
import {
  listLiveTerminalHostSessions,
  hasLiveTerminalHostSessions
} from './terminal-host-session-listing'
import { createOrAttachTerminalSession } from './terminal-host-session-create'
import { TerminalAttachCanceledError } from './daemon-errors'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'
import { randomUUID } from 'node:crypto'
import { pruneRetiredPtyIncarnations } from '../../shared/retired-pty-incarnations'
import { inspectTerminalHostSession } from './terminal-host-process-inspection'
import type { TerminalHostProcessInspection } from './terminal-host-process-inspection'
import {
  confirmTerminalHostForegroundProcess,
  confirmTerminalHostShellForeground,
  getSettledTerminalHostSnapshot,
  getTerminalHostAppliedSize,
  getTerminalHostPartialEscapeTail,
  getTerminalHostSnapshot,
  takeTerminalHostPendingOutput
} from './terminal-host-session-inspection-operations'

export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type { TerminalHostOptions } from './terminal-host-options'

const DEFAULT_MAX_TOMBSTONES = 1000
const REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS = 2_000

export class TerminalHost {
  private sessions = new Map<string, Session>()
  // Serializes creates for one id across async spawn validation.
  private pendingCreations = new Map<string, Promise<void>>()
  private sessionTeardown = new TerminalSessionTeardown(this.sessions)
  private killedTombstones: TerminalHostTombstones
  private readonly spawnOptions: Pick<TerminalHostOptions, 'spawnSubprocess' | 'spawnGate'>
  private onSessionReaped: TerminalHostOptions['onSessionReaped']
  private reportReadinessEvent: TerminalHostOptions['reportReadinessEvent']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private creationFenced = false
  private disposePromise: Promise<void> | null = null
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionGenerations = new TerminalHostAgentSessionGenerations()
  private readonly authorityGeneration = randomUUID()
  private observationEpoch = 0
  private readonly retiredIncarnations = new Map<
    string,
    { incarnationId: string; code: number; expiresAt: number }
  >()

  constructor(opts: TerminalHostOptions) {
    this.spawnOptions = opts
    this.onSessionReaped = opts.onSessionReaped
    this.reportReadinessEvent = opts.reportReadinessEvent
    this.onFinalCheckpoint = opts.onFinalCheckpoint
    this.killedTombstones = new TerminalHostTombstones(opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES)
  }

  async createOrAttach(opts: InternalCreateOrAttachOptions): Promise<CreateOrAttachResult> {
    this.assertCreateOrAttachAllowed(opts)
    for (
      let inFlight = this.pendingCreations.get(opts.sessionId);
      inFlight !== undefined;
      inFlight = this.pendingCreations.get(opts.sessionId)
    ) {
      // Let canceled callers leave rather than wait behind a cwd probe stuck on an unreachable share.
      await waitForTerminalAttachOperation(inFlight, opts.cancelSignal, opts.sessionId)
      this.assertCreateOrAttachAllowed(opts)
    }
    this.assertCreateOrAttachAllowed(opts)

    let settleCreation: () => void = () => {}
    this.pendingCreations.set(
      opts.sessionId,
      new Promise<void>((resolve) => {
        settleCreation = resolve
      })
    )
    try {
      return await createOrAttachClaimedAgentSession({
        options: opts,
        owners: this.agentSessionOwners,
        isLive: (owner) =>
          this.agentSessionGenerations.isCurrent(
            owner,
            Boolean(
              this.sessions.get(owner.ptyId)?.isAlive &&
              !this.sessions.get(owner.ptyId)?.isTerminating
            )
          ),
        createOrAttach: async (options) => {
          this.assertCreateOrAttachAllowed(options)
          if (options.agentSessionGeneration && this.sessions.get(options.sessionId)?.isAlive) {
            throw new Error('agent_session_claim_unavailable')
          }
          return await createOrAttachTerminalSession(options, {
            sessions: this.sessions,
            assertCreateAllowed: () => this.assertCreateOrAttachAllowed(options),
            sessionTeardown: this.sessionTeardown,
            killedTombstones: this.killedTombstones,
            spawnSubprocess: this.spawnOptions.spawnSubprocess,
            spawnGate: this.spawnOptions.spawnGate,
            onDeadSessionRemoved: (sessionId) => this.agentSessionGenerations.forget(sessionId),
            onSessionCreated: (sessionId, generation, isAlive) =>
              this.agentSessionGenerations.remember(sessionId, generation, isAlive),
            ...(this.reportReadinessEvent
              ? { reportReadinessEvent: this.reportReadinessEvent }
              : {}),
            onSessionExit: this.handleSessionExit.bind(this)
          })
        }
      })
    } finally {
      this.pendingCreations.delete(opts.sessionId)
      settleCreation()
    }
  }

  private handleSessionExit(sessionId: string, generation: string | undefined): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      pruneRetiredPtyIncarnations(this.retiredIncarnations)
      this.retiredIncarnations.set(sessionId, {
        incarnationId: session.incarnationId,
        code: session.exitCode ?? 0,
        expiresAt: Date.now() + REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS
      })
    }
    this.agentSessionOwners.release(sessionId, generation)
    this.agentSessionGenerations.forget(sessionId, generation)
    this.reapSession(sessionId)
  }

  private assertCreateOrAttachAllowed(opts: InternalCreateOrAttachOptions): void {
    if (this.creationFenced) {
      throw new Error('Terminal host is shutting down')
    }
    if (opts.isCanceled?.()) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    writeSessionInput(getAliveTerminalHostSession(this.sessions, sessionId), data)
  }

  closeStartupQueryAuthority(sessionId: string): number {
    return getAliveTerminalHostSession(this.sessions, sessionId).closeStartupQueryAuthority()
  }

  resize(sessionId: string, cols: number, rows: number): void {
    getAliveTerminalHostSession(this.sessions, sessionId).resize(cols, rows)
  }

  // Producer flow-control hints tolerate sessions that have already exited.
  pauseProducer(sessionId: string, source?: 'stream', onStreamStall?: () => void): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return
    }
    session.pauseProducer(source, onStreamStall)
  }

  resumeProducer(sessionId: string, source?: 'stream'): void {
    this.sessions.get(sessionId)?.resumeProducer(source)
  }

  kill(sessionId: string, opts: { immediate?: boolean } = {}): Promise<void> {
    const pending = this.sessionTeardown.get(sessionId)
    if (pending) {
      return Promise.resolve(
        opts.immediate ? this.sessionTeardown.requestImmediate(sessionId) : pending
      )
    }
    const session = getAliveTerminalHostSession(this.sessions, sessionId)
    const killed = this.sessionTeardown.killSession(sessionId, session, opts.immediate === true)
    this.killedTombstones.record(sessionId)
    return Promise.resolve(killed)
  }

  beginFencedTermination(request: PtyFencedTerminationRequest) {
    return beginTerminalHostFencedTermination(request, {
      sessions: this.sessions,
      pendingCreations: this.pendingCreations,
      owners: this.agentSessionOwners,
      kill: (id, options) => this.kill(id, options)
    })
  }

  // Reap the emulator so dead sessions do not retain scrollback for the daemon’s lifetime.
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    this.sessions.delete(sessionId)
    this.onSessionReaped?.(sessionId)
  }

  signal(sessionId: string, sig: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    this.detachClients([{ sessionId, token }])
  }

  detachClients(attachments: readonly { sessionId: string; token: symbol }[]): void {
    for (const { sessionId, token } of attachments) {
      this.sessions.get(sessionId)?.detachClient(token)
    }
  }

  async getCwd(sessionId: string): Promise<string | null> {
    return await resolveTerminalHostSessionCwd(
      getAliveTerminalHostSession(this.sessions, sessionId)
    )
  }

  // A vanished pane has no agent icon to display.
  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  inspectProcess(
    sessionId: string,
    options?: PtyProcessInspectionOptions
  ): Promise<TerminalHostProcessInspection> {
    return inspectTerminalHostSession(
      this.sessions,
      this.retiredIncarnations,
      sessionId,
      options,
      this.authorityGeneration,
      () => ++this.observationEpoch
    )
  }

  async confirmForegroundProcess(sessionId: string): Promise<string | null> {
    return confirmTerminalHostForegroundProcess(this.sessions.get(sessionId))
  }

  async confirmShellForeground(sessionId: string): Promise<boolean> {
    return confirmTerminalHostShellForeground(this.sessions.get(sessionId), () =>
      this.sessions.get(sessionId)
    )
  }

  clearScrollback(sessionId: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).clearScrollback()
  }

  resetInputModes(sessionId: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).resetInputModes()
  }

  // Checkpoint reads tolerate sessions that have just exited.
  getSnapshot(sessionId: string, opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    return getTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  async getSettledSnapshot(
    sessionId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<TerminalSnapshot | null> {
    return getSettledTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  // Seed scan-authority handoff with the incomplete escape at the current stream position.
  getPartialEscapeTailAnsi(sessionId: string): string {
    return getTerminalHostPartialEscapeTail(this.sessions.get(sessionId))
  }

  // Let the renderer detect dropped or coerced resizes from the applied dimensions.
  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    return getTerminalHostAppliedSize(this.sessions.get(sessionId))
  }

  takePendingOutput(
    sessionId: string,
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    return takeTerminalHostPendingOutput(this.sessions.get(sessionId), includeSnapshot, opts)
  }

  isKilled(sessionId: string): boolean {
    return this.killedTombstones.has(sessionId)
  }

  listSessions(): SessionInfo[] {
    return listLiveTerminalHostSessions(this.sessions, this.agentSessionOwners)
  }

  hasLiveSessions(): boolean {
    return hasLiveTerminalHostSessions(this.sessions)
  }

  /** Last resort when shutdown overruns its deadline: an async group sweep may not have signalled yet. */
  killLiveSessionGroupsSync(): void {
    killLiveSessionGroupsSync(this.sessions.values())
  }

  dispose(): Promise<void> {
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    const disposePromise = disposeTerminalHostSessions({
      pendingCreations: this.pendingCreations,
      sessionTeardown: this.sessionTeardown,
      sessions: this.sessions,
      onFinalCheckpoint: this.onFinalCheckpoint,
      killedTombstones: this.killedTombstones
    })
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Keep failed native owners retryable on the next shutdown request.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }
}
