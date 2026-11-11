import type { StartedPty } from '../../terminal/recovery/restored-pane-start'
import { OrcaRuntimeWithResumeAgentSessionInWorkspace } from './resume-agent-session-in-workspace'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { buildHeadlessMobileSessionTerminalTabs } from '../../terminal/surface/mobile-session-terminal-projection'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  RecordedAgentSession,
  RecordedAgentSessionResume,
  RecordedAgentSessionTarget
} from '../../../../shared/agent-session/recorded-agent-session'

export abstract class OrcaRuntimeWithRecordedAgentSessions extends OrcaRuntimeWithResumeAgentSessionInWorkspace {
  abstract getTerminalPtyIdForHandle(handle: string): string | null
  private readonly recordedResumes = new Map<string, Promise<StartedPty | null>>()

  async listRecordedAgentSessions(selector: string): Promise<{ sessions: RecordedAgentSession[] }> {
    const workspace = await this.showManagedWorktree(selector)
    return {
      sessions: this.recordedAgentSessions(workspace.id).map((record) => ({
        worktreeId: workspace.id,
        paneKey: record.paneKey,
        agent: record.agent,
        providerSession: record.providerSession,
        connected: this.recordedPanePty(record.paneKey, workspace.id) !== null
      }))
    }
  }

  async resumeRecordedAgentSession(
    selector: string,
    target: RecordedAgentSessionTarget,
    options: { automatic?: boolean } = {}
  ): Promise<RecordedAgentSessionResume> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(selector, undefined, {
      wslUserAct: options.automatic !== true
    })
    const records = this.recordedAgentSessions(workspace.id).filter(
      (record) =>
        (!target.paneKey || record.paneKey === target.paneKey) &&
        (!target.agent || record.agent === target.agent) &&
        (!target.sessionId || record.providerSession.id === target.sessionId)
    )
    if (records.length !== 1) {
      throw new OrchestrationError(
        records.length ? 'agent_session_conflict' : 'agent_session_identity_required',
        records.length
          ? 'More than one saved pane names this conversation. Specify its exact pane key.'
          : 'No recorded conversation matches this workspace and session. No agent was started.'
      )
    }
    const record = records[0]!
    const pane = parsePaneKey(record.paneKey)!
    const reply = (
      ptyId: string,
      disposition: 'resumed' | 'adopted'
    ): RecordedAgentSessionResume => {
      const handle = this.getTerminalHandleForPaneKey(record.paneKey)
      if (!handle || this.getTerminalPtyIdForHandle(handle) !== ptyId) {
        throw new Error('agent_session_ownership_unknown')
      }
      return {
        worktreeId: workspace.id,
        paneKey: record.paneKey,
        agent: record.agent,
        providerSession: record.providerSession,
        handle,
        ptyId,
        disposition
      }
    }
    const live = this.recordedPanePty(record.paneKey, workspace.id)
    if (live) {
      const row = this.getAgentStatusRowsForPane(record.paneKey)
        .filter((entry) => !entry.providerSessionOnly)
        .toSorted((a, b) => b.receivedAt - a.receivedAt)[0]
      const matches =
        !row?.providerSession ||
        agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
      if (matches && this.agentSessionResumeClaims.ownsPty(record, record.paneKey, live)) {
        return reply(live, 'adopted')
      }
      if (
        row?.agentType === record.agent &&
        agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession) &&
        (await this.checkHookAgentPresenceFn?.(record.paneKey, 0)) === 'live'
      ) {
        return reply(live, 'adopted')
      }
      throw new OrchestrationError(
        'agent_session_ownership_unknown',
        'The saved pane already has a terminal, but its conversation could not be verified. No replacement was started.'
      )
    }
    const resumeKey = `${workspace.id}\0${record.paneKey}`
    let restoring = this.recordedResumes.get(resumeKey)
    if (!restoring) {
      restoring = Promise.resolve()
        .then(() =>
          this.ensureRestoredPaneStarted(
            { worktreeId: workspace.id, ...pane },
            {
              resumeSession: { agent: record.agent, providerSession: record.providerSession },
              ...(options.automatic ? { automatic: true } : { wslUserAct: true })
            }
          )
        )
        .then(
          (started) => {
            this.recordedResumes.delete(resumeKey)
            return started
          },
          (error: unknown) => {
            if (!this.agentSessionResumeClaims.hasUnsettledResume(record, record.paneKey)) {
              this.recordedResumes.delete(resumeKey)
            }
            throw error
          }
        )
      this.recordedResumes.set(resumeKey, restoring)
    }
    const started = await restoring
    if (
      !started?.resumedAgentSession ||
      started.resumedAgentSession.agent !== record.agent ||
      !agentProviderSessionsEqual(
        record.agent,
        started.resumedAgentSession.providerSession,
        record.providerSession
      )
    ) {
      throw new OrchestrationError(
        'agent_session_ownership_unknown',
        'The recorded conversation did not resume in its pane. Inspect the original pane before retrying.'
      )
    }
    return reply(started.id, 'resumed')
  }

  private recordedPanePty(paneKey: string, worktreeId: string): string | null {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    const id = handle ? this.getTerminalPtyIdForHandle(handle) : null
    const pty = id ? this.ptysById.get(id) : undefined
    return pty?.connected && worktreeIdsEqual(pty.worktreeId, worktreeId) ? id : null
  }

  private recordedAgentSessions(worktreeId: string): SleepingAgentSessionRecord[] {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return []
    }
    const panes = new Set(
      buildHeadlessMobileSessionTerminalTabs(
        worktreeId,
        session.tabsByWorktree?.[worktreeId] ?? [],
        session
      ).map((tab) => `${tab.parentTabId}:${tab.leafId}`)
    )
    return Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
      (record) =>
        worktreeIdsEqual(record.worktreeId, worktreeId) &&
        panes.has(record.paneKey) &&
        this.isPaneOwnedResumeRecord(record)
    )
  }
}
