import { isShellProcess } from '../../shared/agent-detection'
import { DaemonPtyBufferSnapshots } from './daemon-pty-buffer-snapshots'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import {
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  type ListSessionsResult,
  type SessionInfo
} from './types'
import type {
  PtyProcessInspection,
  PtyProcessInspectionOptions
} from '../providers/pty-process-inspection'
import { clientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'

export abstract class DaemonPtyProcessInspection extends DaemonPtyBufferSnapshots {
  // Detached daemon PTYs can host agents; cleanup must not treat every foreground process as an idle shell.
  protected hasChildProcessesFromForeground(foregroundProcess: string | null): boolean {
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return true
    }
    return this.hasChildProcessesFromForeground(await this.getForegroundProcess(id))
  }

  async inspectProcess(
    id: string,
    options?: PtyProcessInspectionOptions
  ): Promise<PtyProcessInspection> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return clientOnlyUnverifiableInspection('old_host')
    }
    if (this.protocolVersion < COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION) {
      // Pre-v27 daemons need client-side inspection; preserve transport errors to avoid false idle completion.
      const { foregroundProcess } = await this.client.request<{
        foregroundProcess: string | null
      }>('getForegroundProcess', { sessionId: id })
      return {
        foregroundProcess,
        hasChildProcesses: this.hasChildProcessesFromForeground(foregroundProcess)
      }
    }
    return this.client.request<PtyProcessInspection>('inspectProcess', {
      sessionId: id,
      ...(options?.expectedIncarnationId
        ? { expectedIncarnationId: options.expectedIncarnationId }
        : {}),
      // Additive: an older daemon ignores it and pays for the full capture.
      ...(options?.steadyState === true ? { steadyState: true } : {}),
      ...(options?.ignoreDetached === true ? { ignoreDetached: true } : {})
    })
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return null
    }
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'getForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'confirmForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmShellForeground(id: string): Promise<boolean> {
    try {
      const result = await this.client.request<{ confirmed: boolean }>('confirmShellForeground', {
        sessionId: id
      })
      return result.confirmed === true
    } catch {
      return false
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const sessions: Record<string, { initialCwd?: string }> = {}
    for (const id of ids) {
      sessions[id] = { initialCwd: this.initialCwds.get(id) }
    }
    return JSON.stringify(sessions)
  }

  async revive(_state: string): Promise<void> {}

  /** Include priorWorktreeIds in validWorktreeIds: renamed worktrees retain session IDs containing their old paths. */
  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)

    const alive: string[] = []
    const killed: string[] = []

    for (const session of result.sessions) {
      if (!session.isAlive) {
        continue
      }
      // Unminted IDs cannot establish workspace membership and are treated as orphans.
      const { worktreeId } = parsePtySessionId(session.sessionId)

      if (worktreeId === null || !validWorktreeIds.has(worktreeId)) {
        try {
          await this.client.request('kill', { sessionId: session.sessionId })
        } catch {
          /* Orphan cleanup is best-effort. */
        }
        killed.push(session.sessionId)
      } else {
        alive.push(session.sessionId)
        await this.adoptLiveSession(session)
      }
    }

    return { alive, killed }
  }

  /**
   * A session this client never spawned or reattached, such as one a relaunched app's window has
   * not reopened: adopted before its Sleep, or that Sleep writes no checkpoint and keeps no folder.
   */
  protected async adoptListedSessionForSleep(
    sessionId: string,
    deadlineMs?: number
  ): Promise<void> {
    // Why active too: a session this client suspended after a seed failure must stay suspended,
    // or its fresh-only screen would replace the history it was restored from.
    if (
      !this.historyManager ||
      this.historyManager.hasWriter(sessionId) ||
      this.activeSessionIds.has(sessionId)
    ) {
      return
    }
    const result = await this.client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      remainingDaemonRequestTimeoutMs(deadlineMs)
    )
    const session = result.sessions.find((entry) => entry.sessionId === sessionId && entry.isAlive)
    if (session) {
      await this.adoptLiveSession(session, { activeOnlyIfReconciled: true })
    }
  }

  private async adoptLiveSession(
    session: SessionInfo,
    opts: { activeOnlyIfReconciled?: boolean } = {}
  ): Promise<void> {
    // Include background sessions in the final disconnect checkpoint.
    if (!opts.activeOnlyIfReconciled) {
      this.activeSessionIds.add(session.sessionId)
    }
    // Sleep reads a WSL shell's folder by what only the daemon still knows about the pane.
    if (session.wslDistro) {
      this.wslDistrosBySessionId.set(session.sessionId, session.wslDistro)
      if (session.paneKey) {
        this.wslPaneKeysBySessionId.set(session.sessionId, session.paneKey)
      }
    }
    await this.reconcileLiveSessionHistory(session).catch((err) =>
      console.warn('[history] live-session reconciliation failed:', session.sessionId, err)
    )
    // Why after: an exit seen during the reconcile closed the writer; that session is not live.
    if (opts.activeOnlyIfReconciled && this.historyManager?.hasWriter(session.sessionId)) {
      this.activeSessionIds.add(session.sessionId)
    }
  }

  protected async reconcileLiveSessionHistory(session: SessionInfo): Promise<void> {
    const historyManager = this.historyManager
    const historyReader = this.historyReader
    if (!historyManager || !historyReader) {
      return
    }
    await this.withHistorySpawnLock(session.sessionId, async () => {
      if (historyManager.hasWriter(session.sessionId)) {
        return
      }
      const probe = historyReader.probeRestorableHistory(session.sessionId)
      if (probe.status === 'unreadable') {
        return
      }
      if (probe.status === 'none') {
        await historyManager.openSession(session.sessionId, {
          cwd: session.cwd ?? '',
          cols: session.cols,
          rows: session.rows
        })
      } else {
        const recoveryFreeze = await historyManager.freezeForRecovery(session.sessionId)
        try {
          const detection = await historyReader.detectColdRestoreState(session.sessionId, {
            wslDistro: session.wslDistro ?? undefined
          })
          if (
            detection.status === 'unreadable' ||
            (detection.status === 'restored' && detection.hasUnreadableRecovery)
          ) {
            historyManager.suspendSession(session.sessionId, recoveryFreeze)
            return
          }
          historyManager.reopenSession(session.sessionId, recoveryFreeze)
        } finally {
          historyManager.abandonRecoveryFreeze(recoveryFreeze)
        }
      }
      if (historyManager.hasWriter(session.sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(session.sessionId)
        this.sessionsNeedingContinuityCheckpoint.add(session.sessionId)
        this.lastFullCheckpointAt.delete(session.sessionId)
        this.markSessionDirty(session.sessionId)
      }
    })
  }
}
