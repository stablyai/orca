import { isShellProcess } from '../../shared/agent-detection'
import { DaemonPtyBufferSnapshots } from './daemon-pty-buffer-snapshots'
import { parsePtySessionId } from './pty-session-id'
import {
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  type ListSessionsResult,
  type SessionInfo
} from './types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export abstract class DaemonPtyProcessInspection extends DaemonPtyBufferSnapshots {
  // Why: daemon-backed PTYs can host long-lived agents while detached; cleanup prompts must not treat them as idle shells.
  protected hasChildProcessesFromForeground(foregroundProcess: string | null): boolean {
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return true
    }
    return this.hasChildProcessesFromForeground(await this.getForegroundProcess(id))
  }

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
    }
    if (this.protocolVersion < COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION) {
      // Why: pre-v27 daemons survive an in-place app update; compose the inspection client-side from the
      // one call they do support instead of throwing, or completion detection stays dead until recreate.
      // Requests directly (not via getForegroundProcess) so a dead socket still rejects rather than
      // reading as an idle foreground and dispatching a false completion.
      const { foregroundProcess } = await this.client.request<{
        foregroundProcess: string | null
      }>('getForegroundProcess', { sessionId: id })
      return {
        foregroundProcess,
        hasChildProcesses: this.hasChildProcessesFromForeground(foregroundProcess)
      }
    }
    return this.client.request<{
      foregroundProcess: string | null
      hasChildProcesses: boolean
    }>('inspectProcess', { sessionId: id })
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

  async revive(_state: string): Promise<void> {
    // Sessions already live in the daemon — no revival needed
  }

  /** Called on app launch. Lists daemon sessions, kills orphans whose workspaceId
   *  no longer exists, and caches alive session IDs.
   *
   *  IMPORTANT: a session id embeds the worktree's path at spawn time, so a renamed
   *  worktree keeps its old id. Callers MUST seed `validWorktreeIds` with each live
   *  worktree's `WorktreeMeta.priorWorktreeIds` or those sessions get reaped as false
   *  orphans. No production caller yet; wire the alias in when it gains one. */
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
      // Why: an unminted session id (worktreeId === null) can't be tied to a live worktree, so it's treated as an orphan.
      const { worktreeId } = parsePtySessionId(session.sessionId)

      if (worktreeId === null || !validWorktreeIds.has(worktreeId)) {
        try {
          await this.client.request('kill', { sessionId: session.sessionId })
        } catch {
          /* already dead */
        }
        killed.push(session.sessionId)
      } else {
        alive.push(session.sessionId)
        // Why: track background sessions in the checkpoint set so disconnectOnly's final checkpoint doesn't leave stale recovery data.
        this.activeSessionIds.add(session.sessionId)
        await this.reconcileLiveSessionHistory(session).catch((err) =>
          console.warn('[history] live-session reconciliation failed:', session.sessionId, err)
        )
      }
    }

    return { alive, killed }
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
