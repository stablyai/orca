import type { DaemonLaunchNoteChange } from '../../protocol/daemon-launch-note-protocol'
import {
  PTY_FOREGROUND_OBSERVATION_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION
} from '../../protocol/daemon-protocol-version'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { DaemonPtyBufferSnapshots } from '../checkpointing/daemon-pty-buffer-snapshots'
import { parsePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'

import type { HistoryWriterAdmission } from '../../history/storage/terminal-history-writer-handoff'
import type { ListSessionsResult } from '../../protocol/daemon-rpc-contract'
import type { SessionInfo } from '../../protocol/daemon-session-info'
import type { PtyProcessInspectionOptions } from '../../../providers/pty-process-inspection'

import {
  type TerminalProcessInspection as PtyProcessInspection,
  clientOnlyUnverifiableInspection
} from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { remainingDaemonRequestTimeoutMs } from '../../launch/daemon-request-deadline'

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

  supportsForegroundObservation(_id: string): boolean {
    return this.protocolVersion >= PTY_FOREGROUND_OBSERVATION_PROTOCOL_VERSION
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
      ...(options?.foregroundOnly === true ? { foregroundOnly: true } : {}),
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

  setLaunchNote(id: string, change: DaemonLaunchNoteChange): void {
    // Why fire and forget: an older daemon rejects the request and keeps no note, so restore declines.
    void this.client.request('setLaunchNote', { sessionId: id, change }).catch(() => undefined)
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

  /** Recover daemon-only ownership and WSL pane keys before Sleep checkpoints a reopened session. */
  protected async adoptListedSessionForSleep(
    sessionId: string,
    deadlineMs?: number
  ): Promise<void> {
    // Keep seed-failed sessions suspended so a fresh screen cannot overwrite their restore history.
    const needsAdoption =
      !!this.historyManager &&
      !this.historyManager.hasWriter(sessionId) &&
      !this.activeSessionIds.has(sessionId)
    const needsPaneKey =
      process.platform === 'win32' &&
      !needsAdoption &&
      !this.wslPaneKeysBySessionId.has(sessionId) &&
      this.wslDistrosBySessionId.get(sessionId) !== undefined
    if (!needsAdoption && !needsPaneKey) {
      return
    }
    // Captured before the inventory, lock and replay awaits that precede any writer install.
    const admission = needsAdoption ? this.historyManager?.admit(sessionId) : undefined
    const result = await this.client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      remainingDaemonRequestTimeoutMs(deadlineMs)
    )
    const session = result.sessions.find((entry) => entry.sessionId === sessionId && entry.isAlive)
    if (session && needsAdoption) {
      await this.adoptLiveSession(session, { activeOnlyIfReconciled: true }, admission)
    } else if (session?.wslDistro && session.paneKey) {
      this.wslPaneKeysBySessionId.set(sessionId, session.paneKey)
    }
  }

  private async adoptLiveSession(
    session: SessionInfo,
    opts: { activeOnlyIfReconciled?: boolean } = {},
    admission = this.historyManager?.admit(session.sessionId)
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
    await this.reconcileLiveSessionHistory(session, admission).catch((err) =>
      console.warn('[history] live-session reconciliation failed:', session.sessionId, err)
    )
    // Why after: an exit seen during the reconcile closed the writer; that session is not live.
    if (opts.activeOnlyIfReconciled && this.historyManager?.hasWriter(session.sessionId)) {
      this.activeSessionIds.add(session.sessionId)
    }
  }

  protected async reconcileLiveSessionHistory(
    session: SessionInfo,
    admission: HistoryWriterAdmission | undefined
  ): Promise<void> {
    const historyManager = this.historyManager
    const historyReader = this.historyReader
    if (!historyManager || !historyReader || !admission) {
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
          rows: session.rows,
          admission
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
          historyManager.reopenSession(session.sessionId, recoveryFreeze, admission)
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
