import { emitPtyListeners, createPtyExitPayload } from './daemon-pty-listener-emission'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import { recordAuthenticatedInventory } from './daemon-audit-classifier'
import {
  isDaemonEndpointRefusedError,
  isMissingWindowsNamedPipeError
} from './daemon-endpoint-errors'
import { DaemonPtyProcessInspection } from './daemon-pty-process-inspection'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { parsePtySessionId } from './pty-session-id'
import { legacyDaemonProcessLiveness } from './legacy-daemon-exit-evidence'
import { notifyDaemonAuditListeners, removeDaemonListener } from './daemon-listener-registry'
import type { ListSessionsResult, SessionInfo } from './types'
import { PtyProcessListAdmission } from '../providers/pty-process-list-admission'
import type { PtyProcessInfo } from '../providers/types'

export abstract class DaemonPtySessionInventory extends DaemonPtyProcessInspection {
  private daemonExited = false
  private readonly daemonExitedListeners: (() => void)[] = []

  /** True once this preserved older-protocol daemon has provably exited; it never owns a session again. */
  hasDaemonExited(): boolean {
    return this.daemonExited
  }

  onDaemonExited(listener: () => void): () => void {
    this.daemonExitedListeners.push(listener)
    return () => removeDaemonListener(this.daemonExitedListeners, listener)
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    if (this.daemonExited) {
      return []
    }
    // Why: snapshotted before the request so ids spawned mid-flight can never
    // be reconciled away below.
    const preRequestActiveIds = new Set(this.activeSessionIds)
    try {
      // Why retry: this inventory is what destructive teardown consults, and a
      // dead host pipe surfaced as `connect ENOENT \\?\\pipe\\orca-terminal-host-...`
      // that failed worktree removal until the app was restarted (#10087). Spawn
      // already recovered from exactly this; inventory did not, so the one path
      // that must not get stuck was the only one that could not heal.
      //
      // Why the request is inside too: a host that dies between connect and
      // listSessions throws the same daemon-gone error, so retrying only the
      // connect would still fail. The reconciliation below stays outside --
      // retrying that would double-apply it.
      //
      // Why: connect + listSessions share the caller's one absolute deadline so a
      // wedged handshake cannot burn the whole teardown budget before the list issues.
      const result = await this.withDaemonRetry(async () => {
        await this.ensureConnected(opts?.deadlineMs)
        return this.client.request<ListSessionsResult>(
          'listSessions',
          undefined,
          remainingDaemonRequestTimeoutMs(opts?.deadlineMs)
        )
      }).catch((error: unknown) => this.inventoryOfExitedLegacyDaemon(error))
      const admission = new PtyProcessListAdmission()
      const processes: PtyProcessInfo[] = []
      const aliveSessionIds = new Set<string>()
      for (const session of result?.sessions ?? []) {
        if (!session.isAlive) {
          continue
        }
        aliveSessionIds.add(session.sessionId)
        const { worktreeId } = parsePtySessionId(session.sessionId)
        processes.push(
          admission.admit({
            id: session.sessionId,
            ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
            ...(session.pid ? { rootProcessId: session.pid } : {}),
            // Why: OSC 7 may not arrive before cleanup; spawn cwd is authoritative until the daemon reports a live cwd.
            cwd: session.cwd ?? this.initialCwds.get(session.sessionId) ?? '',
            title: 'shell',
            ...(worktreeId ? { worktreeId } : {}),
            ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
            ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {}),
            ...(session.state === 'exiting' ? { exiting: true as const } : {}),
            ...this.validatedAgentSessionOwners(session.agentSessionOwners)
          })
        )
      }
      // Why: hasPty reads activeSessionIds, and an exit missed while the socket
      // was disconnected otherwise survives an authoritative inventory forever —
      // defeating every absence proof built on the cache.
      for (const id of preRequestActiveIds) {
        if (!aliveSessionIds.has(id)) {
          this.activeSessionIds.delete(id)
        }
      }
      if (result) {
        this.publishAuditObservation(
          recordAuthenticatedInventory(this.auditContext, this.exactDaemonIncarnation)
        )
      }
      return processes
    } catch (error) {
      const missingAuthenticatedToken = this.isRetiredEndpointTokenMissing()
      const missingNamedPipe = isMissingWindowsNamedPipeError(error)
      this.observeAuditFailure(
        missingAuthenticatedToken
          ? 'token_missing_after_authenticated_disconnect'
          : 'inventory_failed',
        this.exactDaemonIncarnation,
        [
          ...(missingAuthenticatedToken ? (['token_file'] as const) : []),
          ...(missingNamedPipe ? (['windows_named_pipe'] as const) : [])
        ],
        missingNamedPipe ? 'windows_named_pipe_missing' : undefined
      )
      throw error
    }
  }

  protected validatedAgentSessionOwners(
    owners: unknown
  ): { agentSessionOwners: AgentSessionOwnerBinding[] } | Record<string, never> {
    if (owners === undefined) {
      return {}
    }
    if (
      !Array.isArray(owners) ||
      owners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES ||
      !owners.every((owner) => isAgentSessionOwnerBinding(owner) && owner.phase === 'live')
    ) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owners.length > 0
      ? { agentSessionOwners: owners.map(cloneAgentSessionOwnerBinding) }
      : {}
  }

  // Why: the Manage Sessions panel needs the full SessionInfo (pid, state,
  // createdAt) per session for display; listProcesses drops that detail for
  // the IPtyProvider contract. Keep both in parallel rather than widening
  // the provider surface.
  async listSessions(): Promise<SessionInfo[]> {
    if (this.daemonExited) {
      return []
    }
    const result = await this.ensureConnected()
      .then(() => this.client.request<ListSessionsResult>('listSessions', undefined))
      .catch((error: unknown) => this.inventoryOfExitedLegacyDaemon(error))
    if (!result) {
      return []
    }
    return result.sessions
      .filter((s) => s.isAlive)
      .map((session) => ({
        ...session,
        ...this.validatedAgentSessionOwners(session.agentSessionOwners)
      }))
  }

  /**
   * Marks this adapter's daemon exited when it is a preserved older-protocol daemon that has exited.
   *
   * Why: nothing respawns a legacy daemon, so once it exits (idle shutdown, or a signal) its
   * endpoint refuses for the rest of the app's life. Keeping it in every adapter set blocked every
   * worktree delete with `connect ECONNREFUSED daemon-v<old>.sock` until Orca restarted. A
   * refused endpoint plus no process behind any known pid proves it owns no sessions; anything
   * weaker (a timeout, a live or unreadable pid) still fails closed. The mark is final, so
   * holders drop it once instead of every reader re-probing.
   */
  protected markLegacyDaemonExitedIfProven(error: unknown): boolean {
    if (this.daemonExited) {
      return true
    }
    if (
      this.respawnFn ||
      !isDaemonEndpointRefusedError(error) ||
      legacyDaemonProcessLiveness(this.pidPath, this.pidRecord).status !== 'exited'
    ) {
      return false
    }
    this.daemonExited = true
    // Why no exits or dispose: panes recover through attach and cold restore, which dispose would suppress.
    this.clearSessionTracking()
    console.warn(`[daemon] protocol v${this.protocolVersion} daemon exited; dropping its adapter`)
    notifyDaemonAuditListeners(this.daemonExitedListeners, undefined)
    return true
  }

  /** An exited daemon's inventory is empty; any other failure propagates. */
  protected inventoryOfExitedLegacyDaemon(error: unknown): null {
    if (!this.markLegacyDaemonExitedIfProven(error)) {
      throw error
    }
    return null
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  // Why: the daemon's kill-all-and-shutdown path suppresses onExit fanout (session.ts:246-252), so synthesize pty:exit
  // for every live session before teardown or renderer panes black-hole writes to a disposed adapter forever.
  fanoutSyntheticExits(code: number): void {
    const ids = this.clearSessionTracking()
    for (const id of ids) {
      this.coldRestoreCache.delete(id)
      // Why: don't catch listener throws — matches the natural onExit fanout so synthetic exits keep the same error semantics.
      emitPtyListeners(this.exitListeners, (listener) =>
        listener(
          createPtyExitPayload(id, { code, incarnationId: this.sessionIncarnations.get(id) })
        )
      )
      this.sessionIncarnations.delete(id)
    }
  }

  /** Forgets every live session and stops checkpointing; returns the ids that were active. */
  private clearSessionTracking(): string[] {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.stopCheckpointTimer()
    return ids
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }
}
