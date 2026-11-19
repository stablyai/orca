import type { TerminalIdentityReadContext } from '../query/terminal-identity-read-context'
import { sleepingRecordsEquivalentIgnoringCaptureTime } from '../../../../shared/agent-session/lifecycle/resume/agent-resume-record-equivalence'
import { OrcaRuntimeWithStopTerminalsForWorktree } from './worktree-terminal-stop'
import { launchStatement } from '../launch/launch-evidence'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
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
import type { ResumeRecordStatus } from '../../../../shared/agent-session/lifecycle/resume/agent-resume-record-from-status'
import { applyWindowLayoutCommand } from '../layout/runtime-layout-apply'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'

import {
  type ExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

export abstract class OrcaRuntimeWithWorktreeSleepResumeRecording extends OrcaRuntimeWithStopTerminalsForWorktree {
  /** Capture after earlier status writes so their saved copy participates in exact cleanup. */
  readSavedResumeSource(
    worktreeId: string,
    paneKey: string,
    /** A capture resolves its workspace's host once for every pane. */
    hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
  ): Promise<SleepingAgentSessionRecord | undefined> {
    return this.inResumeRecordOrder(
      async () =>
        this.store?.getWorkspaceSession?.(hostId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
    )
  }

  /** A confirmed quit retires its saved recovery, which the next coalesced save persists; answers
   *  the record saved when it quit, read through the same host route. */
  retireExitedPaneResume(
    paneKey: string,
    exitedAt: number
  ): SleepingAgentSessionRecord | undefined {
    this.previousHookStatusByPaneKey.delete(paneKey)
    const worktreeId = this.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!worktreeId) {
      return undefined
    }
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    this.inResumeRecordOrder(async () => {
      this.store?.retireSleepingAgentSession?.(
        paneKey,
        (saved) => saved.updatedAt <= exitedAt,
        hostId
      )
    }).catch((error) =>
      console.warn('[runtime] could not retire an exited agent resume record', error)
    )
    return this.store?.getWorkspaceSession?.(hostId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
  }

  /** Forgets a pane's saved resume the host refused because a chat is its conversation's home,
   *  as a window does for its own panes; a host with no window has no one else to. */
  async forgetRefusedSavedResume(
    worktreeId: string,
    paneKey: string,
    refused: RefusedPaneResume,
    source?: SleepingAgentSessionRecord
  ): Promise<void> {
    await this.inResumeRecordOrder(() =>
      this.commitWorkspaceSessionEdit(
        this.getWorkspaceSessionHostIdForWorktree(worktreeId),
        (session) => {
          const saved = session.sleepingAgentSessionsByPaneKey?.[paneKey]
          if (
            !source ||
            !refused.expectedSavedRecord ||
            saved?.paneKey !== refused.expectedSavedRecord.paneKey ||
            saved.capturedAt !== refused.expectedSavedRecord.capturedAt ||
            saved.updatedAt !== refused.expectedSavedRecord.updatedAt ||
            saved.connectionId !== source.connectionId ||
            !sleepingRecordsEquivalentIgnoringCaptureTime(saved, source) ||
            saved.agent !== refused.agent ||
            !agentProviderSessionsEqual(
              refused.agent,
              saved.providerSession,
              refused.providerSession
            )
          ) {
            return null
          }
          const { [paneKey]: _refused, ...kept } = session.sleepingAgentSessionsByPaneKey ?? {}
          return { ...session, sleepingAgentSessionsByPaneKey: kept }
        }
      )
    )
    const previous = this.previousHookStatusByPaneKey.get(paneKey)
    if (
      previous &&
      refused.expectedStatus &&
      previous.updatedAt <= refused.expectedStatus.receivedAt &&
      previous.stateStartedAt === refused.expectedStatus.stateStartedAt &&
      previous.agentType === refused.agent &&
      agentProviderSessionsEqual(refused.agent, previous.providerSession, refused.providerSession)
    ) {
      this.previousHookStatusByPaneKey.delete(paneKey)
    }
  }

  protected readonly sleepResumeRecords: WorktreeSleepResumeRecorder = {
    capture: async (worktreeId, ptyIds) => {
      const paneKeysByPtyId = new Map(
        [...ptyIds].map((ptyId) => [ptyId, this.collectAgentStatusPaneKeysForPty(ptyId)])
      )
      // Settle every pane's exit proof at once, so their process-table reads coalesce.
      const paneKeys = new Set([...paneKeysByPtyId.values()].flatMap((keys) => [...keys]))
      const settle = this.checkHookAgentPresenceFn
      if (settle) {
        await Promise.all([...paneKeys].map((key) => settle(key, 0, { settleForSleep: true })))
      }
      const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
      return captureWorktreeSleepResumeRecords({
        worktreeId,
        paneKeysByPtyId,
        launchByPtyId: new Map([...ptyIds].map((ptyId) => [ptyId, this.ptysById.get(ptyId)])),
        readRowsForPane: (paneKey) => this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? [],
        readSavedRecord: (paneKey) => this.readSavedResumeSource(worktreeId, paneKey, hostId),
        readIdentity: (paneKey, savedRecord) => this.readPaneAgentIdentity(paneKey, savedRecord),
        checkAgentPresence: (paneKey, since) =>
          this.checkHookAgentPresenceFn?.(paneKey, since) ?? Promise.resolve(null),
        capturedAt: Date.now()
      })
    },
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
  private readonly previousHookStatusByPaneKey = new Map<
    string,
    ResumeRecordStatus & { stateStartedAt?: number }
  >()
  private hookStatusResumeWrites: Promise<void> = Promise.resolve()

  protected abstract getPtyRecordForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): RuntimePtyWorktreeRecord | null

  /** Main's word on the Orca launch running in this pane now; the one check every saved note passes. */
  getLaunchStatementForPaneKey: PaneLaunchConfigOf = (paneKey, agent) =>
    launchStatement(this.getPtyRecordForPaneKey(paneKey), agent)

  /** The same word for a pane whose PTY the caller already resolved. */
  getLaunchStatementForPty(ptyId: string, agent: string | null | undefined) {
    return launchStatement(this.ptysById.get(ptyId), agent)
  }

  // Main records accepted status for its panes even without windows, preserving window resume rules; serialize writes so statuses read prior records.
  recordHookStatusResume(row: AgentStatusIpcPayload): void {
    const status = resumeStatusFromHookRow(row, this.previousHookStatusByPaneKey.get(row.paneKey))
    if (!status) {
      return
    }
    this.previousHookStatusByPaneKey.set(row.paneKey, {
      ...status,
      stateStartedAt: row.stateStartedAt
    })
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
    if (!('paneKey' in clear)) {
      for (const [paneKey, status] of this.previousHookStatusByPaneKey) {
        if (status.connectionId === clear.connectionId) {
          this.previousHookStatusByPaneKey.delete(paneKey)
        }
      }
      return
    }
    const status = this.previousHookStatusByPaneKey.get(clear.paneKey)
    const refused = clear.refusedResume
    if (
      status &&
      (!refused ||
        (!!refused.expectedStatus &&
          status.updatedAt <= refused.expectedStatus.receivedAt &&
          status.stateStartedAt === refused.expectedStatus.stateStartedAt &&
          status.agentType === refused.agent &&
          agentProviderSessionsEqual(
            status.agentType,
            status.providerSession,
            refused.providerSession
          )))
    ) {
      this.previousHookStatusByPaneKey.delete(clear.paneKey)
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
      launchConfigOf: this.getLaunchStatementForPaneKey,
      paneIsLive: this.hasLiveTerminalForPaneKey(status.paneKey)
    })
    if (command) {
      // Not this.applyLayoutCommand: this runs inside the resume-record queue, which that would await.
      await applyWindowLayoutCommand(this.store, hostIdsFor, command)
    }
  }

  /** A layout-owner build's quit capture of the agents of the panes one partition holds. */
  quitResumeRecordsFor(session: WorkspaceSessionState): SleepingAgentSessionRecord[] {
    // A saved-only pane quits only while its terminal runs; an asleep pane keeps its sleep record
    // and a live checkpoint stays as saved, as main leaves both. One identity read for every pane.
    const context = this.createTerminalIdentityReadContext()
    const paneKeys = new Set([
      ...(this.getAgentProviderSessionSnapshotFn?.() ?? []).map((row) => row.paneKey),
      ...Object.values(session.sleepingAgentSessionsByPaneKey ?? {})
        .filter(
          (saved) =>
            saved.origin !== 'live' && this.hasLiveTerminalForPaneKey(saved.paneKey, context)
        )
        .map((saved) => saved.paneKey)
    ])
    const statuses = [...paneKeys].flatMap((paneKey) => {
      const identity = this.readPaneAgentIdentity(
        paneKey,
        session.sleepingAgentSessionsByPaneKey?.[paneKey]
      )
      if (!identity || identity.ended || identity.executionHost === 'shared') {
        return []
      }
      const status = resumeStatusFromHookRow(
        identity.status,
        this.previousHookStatusByPaneKey.get(paneKey)
      )
      return status ? [status] : []
    })
    return quitResumeRecords({
      statuses,
      session,
      worktreeIdOf: (paneKey) => this.getTerminalWorktreeIdForPaneKey(paneKey),
      launchConfigOf: (paneKey, agent) =>
        launchStatement(this.getPtyRecordForPaneKey(paneKey, context), agent),
      capturedAt: Date.now()
    })
  }
}
