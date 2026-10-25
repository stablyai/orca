import { OrcaRuntimeWithStopTerminalsForWorktree } from './worktree-terminal-stop'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords,
  type WorktreeSleepResumeRecorder
} from './worktree-sleep-resume-records'
import {
  hookStatusResumeCommand,
  quitResumeRecords,
  resumeStatusFromHookRow,
  type PaneLaunchConfigOf
} from './hook-status-resume-records'
import type { ResumeRecordStatus } from '../../../../shared/agent-resume-record-from-status'
import { applyWindowLayoutCommand } from '../../runtime-layout-apply'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

export abstract class OrcaRuntimeWithWorktreeSleepResumeRecording extends OrcaRuntimeWithStopTerminalsForWorktree {
  protected readonly sleepResumeRecords: WorktreeSleepResumeRecorder = {
    capture: (worktreeId, ptyIds) =>
      captureWorktreeSleepResumeRecords({
        worktreeId,
        paneKeysByPtyId: new Map(
          [...ptyIds].map((ptyId) => [ptyId, this.collectAgentStatusPaneKeysForPty(ptyId)])
        ),
        launchByPtyId: new Map(
          [...ptyIds].map((ptyId) => {
            const pty = this.ptysById.get(ptyId)
            return [ptyId, { agent: pty?.launchAgent ?? null, config: pty?.launchConfig ?? null }]
          })
        ),
        readRows: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
        checkAgentPresence: this.checkHookAgentPresenceFn,
        capturedAt: Date.now()
      }),
    persist: async (worktreeId, capture, stoppedPtyIds) => {
      const commit = (): Promise<void> =>
        this.commitWorkspaceSessionEdit(
          this.getWorkspaceSessionHostIdForWorktree(worktreeId),
          (session) => applyWorktreeSleepResumeRecords(session, capture, stoppedPtyIds)
        )
      try {
        // Switch point: a status accepted before the sleep is saved is written before it, as in the window.
        await (ORCA_LAYOUT_OWNER_IS_MAIN ? this.inResumeRecordOrder(commit) : commit())
      } catch (error) {
        // Why: the PTYs already stopped; a lost record costs the resume, not the sleep.
        console.error('[runtime] could not record slept agent sessions', { worktreeId, error })
      }
    }
  }

  /** Each pane's last hook status, which a status without a provider session inherits it from. */
  private readonly previousHookStatusByPaneKey = new Map<string, ResumeRecordStatus>()
  private hookStatusResumeWrites: Promise<void> = Promise.resolve()

  private readonly paneLaunchConfigOf: PaneLaunchConfigOf = (paneKey, agent) => {
    for (const pty of this.ptysById.values()) {
      if (
        pty.launchConfig &&
        pty.launchAgent === agent &&
        this.paneOfPty(pty).paneKey === paneKey
      ) {
        return pty.launchConfig
      }
    }
    return undefined
  }

  // Main records accepted status for its panes even without windows, preserving window resume rules; serialize writes so statuses read prior records.
  recordHookStatusResume(row: AgentStatusIpcPayload): void {
    const status = resumeStatusFromHookRow(row, this.previousHookStatusByPaneKey.get(row.paneKey))
    if (!status) {
      return
    }
    this.previousHookStatusByPaneKey.set(row.paneKey, status)
    this.inResumeRecordOrder(() => this.writeHookStatusResume(status)).catch((error) =>
      console.warn('[runtime] could not record an agent resume record', error)
    )
  }

  /** Runs `write` after every resume record write queued before it. */
  protected inResumeRecordOrder<T>(write: () => Promise<T>): Promise<T> {
    const written = this.hookStatusResumeWrites.then(write)
    this.hookStatusResumeWrites = written.then(
      () => {},
      () => {}
    )
    return written
  }

  /** A cleared status leaves the record alone (lost contact is no evidence), as in the window. */
  forgetHookStatusResume(clear: AgentStatusClearIpcPayload): void {
    for (const [paneKey, status] of this.previousHookStatusByPaneKey) {
      if (
        'paneKey' in clear ? paneKey === clear.paneKey : status.connectionId === clear.connectionId
      ) {
        this.previousHookStatusByPaneKey.delete(paneKey)
      }
    }
  }

  private async writeHookStatusResume(status: ResumeRecordStatus): Promise<void> {
    const tabId = parsePaneKey(status.paneKey)?.tabId
    const worktreeId = status.worktreeId ?? this.getTerminalWorktreeIdForPaneKey(status.paneKey)
    if (!tabId || !worktreeId || !this.store?.getWorkspaceSession) {
      return
    }
    const hostIdsFor = (workspace: string): ExecutionHostId[] =>
      this.getWorkspaceSessionHostIdsForTab(workspace, tabId)
    // Why: a paired server's panes are that server's; its own main records them.
    const hostId = hostIdsFor(worktreeId)[0]
    if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
      return
    }
    const command = hookStatusResumeCommand({
      status,
      session: this.store.getWorkspaceSession(hostId),
      worktreeId,
      launchConfigOf: this.paneLaunchConfigOf
    })
    if (command) {
      // Not this.applyLayoutCommand: this runs inside the resume-record queue, which that would await.
      await applyWindowLayoutCommand(this.store, hostIdsFor, command)
    }
  }

  /** A layout-owner build's quit capture of the agents of the panes one partition holds. */
  quitResumeRecordsFor(session: WorkspaceSessionState): SleepingAgentSessionRecord[] {
    const statuses = (this.getAgentProviderSessionSnapshotFn?.() ?? []).flatMap((row) => {
      const status = resumeStatusFromHookRow(row, this.previousHookStatusByPaneKey.get(row.paneKey))
      return status ? [status] : []
    })
    return quitResumeRecords({
      statuses,
      session,
      worktreeIdOf: (paneKey) => this.getTerminalWorktreeIdForPaneKey(paneKey),
      launchConfigOf: this.paneLaunchConfigOf,
      capturedAt: Date.now()
    })
  }
}
