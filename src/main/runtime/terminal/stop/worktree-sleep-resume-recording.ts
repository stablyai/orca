import { paneSleepTargetMatches, paneSleepStopMatches } from './pane-sleep-admission'
import type {
  PaneSleepTarget,
  PaneSleepStopCondition
} from '../../../../shared/agent-session/lifecycle/pane-sleep-target'
import { hostSleepKey } from './worktree-terminal-sleep-key'
import { readWorktreeSleepAgentStatus } from './worktree-sleep-agent-status'
import { prepareWorktreeSleepRecords } from './worktree-sleep-record-transaction'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeAgentRowSnapshot } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import {
  isPaneSleepRecord,
  isResumablePaneRecord,
  resumablePaneRecord,
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import { sleepingRecordsEquivalentIgnoringCaptureTime } from '../../../../shared/agent-session/lifecycle/agent-resume-record-equivalence'
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
  resumeStatusesFromHookRows,
  resumeStatusFromHookRow,
  type PaneLaunchConfigOf
} from './hook-status-resume-records'
import type { ResumeRecordStatus } from '../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { applyWindowLayoutCommand } from '../layout/runtime-layout-apply'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

import { type ExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

export abstract class OrcaRuntimeWithWorktreeSleepResumeRecording extends OrcaRuntimeWithStopTerminalsForWorktree {
  /** Capture after earlier status writes so their saved copy participates in exact cleanup. */
  readSavedResumeSource(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentSessionRecord | undefined> {
    return this.inResumeRecordOrder(async () =>
      resumablePaneRecord(
        this.store?.getWorkspaceSession?.(this.getWorkspaceSessionHostIdForWorktree(worktreeId))
          ?.sleepingAgentSessionsByPaneKey?.[paneKey]
      )
    )
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
            !saved ||
            !isResumablePaneRecord(saved) ||
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
    prepare: (worktreeId, capture, isCurrent) =>
      prepareWorktreeSleepRecords(worktreeId, capture, isCurrent, {
        edit: (edit) =>
          this.inResumeRecordOrder(() =>
            this.commitWorkspaceSessionEdit(
              this.getWorkspaceSessionHostIdForWorktree(worktreeId),
              edit
            )
          ),
        ptyById: (ptyId) => this.ptysById.get(ptyId),
        ptyForPane: (paneKey) => this.getPtyRecordForPaneKey(paneKey),
        publish: () => this.notifyMobileSessionTabsChanged(worktreeId)
      }),
    capture: (worktreeId, ptyIds) =>
      captureWorktreeSleepResumeRecords({
        worktreeId,
        paneKeysByPtyId: new Map(
          [...ptyIds].map((ptyId) => [ptyId, this.collectAgentStatusPaneKeysForPty(ptyId)])
        ),
        launchByPtyId: new Map([...ptyIds].map((ptyId) => [ptyId, this.ptysById.get(ptyId)])),
        readRows: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
        checkAgentPresence: this.checkHookAgentPresenceFn,
        readEntry: (ptyId, paneKey) => this.readLivePaneAgentStatus(ptyId, paneKey),
        capturedAt: Date.now()
      }),
    persist: async (worktreeId, capture, stoppedPtyIds) => {
      const commit = (): Promise<void> =>
        this.commitWorkspaceSessionEdit(
          this.getWorkspaceSessionHostIdForWorktree(worktreeId),
          (session) => applyWorktreeSleepResumeRecords(session, capture, stoppedPtyIds)
        )
      try {
        await this.inResumeRecordOrder(commit)
      } catch (error) {
        // Why: the PTYs already stopped; a lost record costs the resume, not the sleep.
        console.error('[runtime] could not record slept agent sessions', { worktreeId, error })
      }
    }
  }

  paneSleepTargetIsCurrent(workspace: string, target: PaneSleepTarget): boolean {
    return paneSleepTargetMatches(
      workspace,
      target,
      this.getPtyRecordForPaneKey(target.paneKey),
      this.readLivePaneAgentStatus(target.ptyId, target.paneKey)
    )
  }

  paneSleepStopIsCurrent(condition: PaneSleepStopCondition): boolean {
    return paneSleepStopMatches(
      condition,
      this.paneSleepTargetIsCurrent(condition.workspace, condition.target),
      this.getWorkspaceSessionForWorktree(condition.workspace)?.sleepingAgentSessionsByPaneKey?.[
        condition.target.paneKey
      ]
    )
  }

  private readLivePaneAgentStatus(ptyId: string, paneKey: string): AgentStatusEntry | null {
    const pty = this.ptysById.get(ptyId)
    return readWorktreeSleepAgentStatus({
      paneKey,
      pty,
      processStartedAt: this.terminalRunFacts.readProcessStartedAt(ptyId),
      session: pty ? this.getWorkspaceSessionForWorktree(pty.worktreeId) : null,
      getRows: (key) =>
        this.getAgentProviderSessionRowsForPaneFn?.(key) ??
        (this.getAgentProviderSessionSnapshotFn?.() ?? []).filter((row) => row.paneKey === key),
      build: (livePty, tab, rows) =>
        this.buildPtyMobileAgentStatus(livePty, tab, null, null, rows).agentStatus
    })
  }

  protected recordTerminalSleepSuccessor(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const records = this.getWorkspaceSessionForWorktree(
      pty.worktreeId
    )?.sleepingAgentSessionsByPaneKey
    for (const paneKey of this.collectPaneKeysForPty(ptyId)) {
      const saved = records?.[paneKey]
      if (!saved || !isPaneSleepRecord(saved)) {
        continue
      }
      const entry = this.readLivePaneAgentStatus(ptyId, paneKey)
      if (!entry) {
        continue
      }
      const observedAt = pty.lastOscTitleEpochMs ?? pty.lastAgentStatusStartedAtEpochMs
      if (observedAt === null || observedAt === undefined) {
        continue
      }
      this.inResumeRecordOrder(() =>
        this.writeHookStatusResume({ ...entry, evidenceObservedAt: observedAt })
      ).catch((error) => console.warn('[runtime] could not record a pane successor', error))
    }
  }

  /** Each pane's last hook status, which a status without a provider session inherits it from. */
  private readonly previousHookStatusByPaneKey = new Map<string, ResumeRecordStatus>()
  private hookStatusResumeWrites: Promise<void> = Promise.resolve()

  protected abstract buildPtyMobileAgentStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getRows: (paneKey: string) => AgentStatusIpcPayload[]
  ):
    | {
        agentStatus: AgentStatusEntry
      }
    | Record<string, never>

  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

  /** Main's word on the Orca launch running in this pane now; the one check every saved note passes. */
  getLaunchStatementForPaneKey: PaneLaunchConfigOf = (paneKey, agent) =>
    launchStatement(this.getPtyRecordForPaneKey(paneKey), agent)

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
    for (const [paneKey, status] of this.previousHookStatusByPaneKey) {
      if (
        'paneKey' in clear
          ? paneKey === clear.paneKey &&
            (!clear.refusedResume ||
              (!!clear.refusedResume.expectedStatus &&
                status.updatedAt <= clear.refusedResume.expectedStatus.receivedAt &&
                status.stateStartedAt === clear.refusedResume.expectedStatus.stateStartedAt &&
                status.agentType === clear.refusedResume.agent &&
                agentProviderSessionsEqual(
                  status.agentType,
                  status.providerSession,
                  clear.refusedResume.providerSession
                )))
          : status.connectionId === clear.connectionId
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
    if (
      this.terminalSleepStateByHostWorktree.get(hostSleepKey(hostId, worktreeId))?.phase ===
      'stopping'
    ) {
      return
    }
    const command = hookStatusResumeCommand({
      status,
      session: this.store.getWorkspaceSession(hostId),
      worktreeId,
      launchConfigOf: this.getLaunchStatementForPaneKey
    })
    if (command) {
      // Not this.applyLayoutCommand: this runs inside the resume-record queue, which that would await.
      await applyWindowLayoutCommand(this.store, hostIdsFor, command)
    }
  }

  /** A layout-owner build's quit capture of the agents of the panes one partition holds. */
  quitResumeRecordsFor(session: WorkspaceSessionState): SleepingAgentSessionRecord[] {
    return quitResumeRecords({
      statuses: resumeStatusesFromHookRows(
        this.getAgentProviderSessionSnapshotFn?.() ?? [],
        this.previousHookStatusByPaneKey
      ),
      session,
      worktreeIdOf: (paneKey) => this.getTerminalWorktreeIdForPaneKey(paneKey),
      launchConfigOf: this.getLaunchStatementForPaneKey,
      capturedAt: Date.now()
    })
  }
}
