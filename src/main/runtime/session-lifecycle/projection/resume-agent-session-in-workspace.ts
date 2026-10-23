// A targeted resume of one recorded agent conversation into a fresh pane of its workspace.

import { OrcaRuntimeWithAgentSessionResumeOwnership } from './agent-session-resume-ownership'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal as OwnedMobileTerminalCreate } from '../../terminal/launch/mobile-terminal-owned-create'
import { deterministicAgentSessionUuid } from '../../runtime-agent-launch-resolution'
import { isUnclaimedRunningSleepRecord } from './sleep-record-pane-claim'
import type { ResumedAgentSession } from './agent-session-resume-claims'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

export type AgentSessionResumeRefusal =
  | 'window_owns_wake'
  | 'held_elsewhere'
  | 'no_resume_command'
  | 'aborted'
  | 'create_failed'

export type AgentSessionResumeResult =
  | { ok: true; handle: string; paneKey: string; ptyId: string }
  | { ok: false; reason: AgentSessionResumeRefusal }

export abstract class OrcaRuntimeWithResumeAgentSessionInWorkspace extends OrcaRuntimeWithAgentSessionResumeOwnership {
  protected abstract createRuntimeOwnedMobileSessionTerminal(
    ...args: Parameters<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>
  ): ReturnType<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>

  /**
   * Resumes one recorded conversation in a fresh pane of its workspace: the exact new binding, or
   * a refusal. Never a plain shell or a fresh agent.
   */
  async resumeAgentSessionInWorkspace(
    worktreeId: string,
    request: {
      agent: TuiAgent
      providerSession: AgentProviderSessionMetadata
      /** The execution host whose hook row reported the session. */
      captureHostId: ExecutionHostId
      /** Names the new pane, so a retry of one request reconciles the pane it may have started. */
      mutationId: string
      signal?: AbortSignal
    }
  ): Promise<AgentSessionResumeResult> {
    const providerSession = normalizeAgentProviderSession(request.providerSession)
    if (!providerSession) {
      return { ok: false, reason: 'no_resume_command' }
    }
    const seed = `${worktreeId}\0${request.mutationId}`
    const identity = {
      tabId: deterministicAgentSessionUuid(`agent-session-resume-tab\0${seed}`),
      leafId: deterministicAgentSessionUuid(`agent-session-resume-leaf\0${seed}`)
    }
    const session: ResumedAgentSession = { agent: request.agent, providerSession }
    const claim = this.agentSessionResumeClaims.claim(
      session,
      makePaneKey(identity.tabId, identity.leafId),
      seed
    )
    if (!claim) {
      return { ok: false, reason: 'held_elsewhere' }
    }
    let dispatched = false
    let failure: unknown
    const result = await this.resumeClaimedAgentSession(worktreeId, session, request, {
      identity,
      onPtySpawnDispatched: () => {
        dispatched = true
      },
      onPtyCreated: claim.bind
    }).catch((error: unknown): AgentSessionResumeResult => {
      failure = error
      return {
        ok: false,
        reason: !dispatched && request.signal?.aborted ? 'aborted' : 'create_failed'
      }
    })
    if (!result.ok) {
      claim.settleFailure(dispatched, failure)
    }
    return result
  }

  private async resumeClaimedAgentSession(
    worktreeId: string,
    session: ResumedAgentSession,
    request: { captureHostId: ExecutionHostId; mutationId: string; signal?: AbortSignal },
    create: {
      identity: { tabId: string; leafId: string }
      onPtySpawnDispatched: () => void
      onPtyCreated: (ptyId: string) => void
    }
  ): Promise<AgentSessionResumeResult> {
    const refuse = (reason: AgentSessionResumeRefusal): AgentSessionResumeResult => ({
      ok: false,
      reason
    })
    if (request.signal?.aborted) {
      return refuse('aborted')
    }
    let workspace
    try {
      workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    } catch {
      return refuse('no_resume_command')
    }
    // Why: a session id names a transcript on the host that reported it; elsewhere it cannot resume.
    if (getConnectionExecutionHostId(workspace.connectionId) !== request.captureHostId) {
      return refuse('no_resume_command')
    }
    // Why its own pane: a retry of this request reconciles the pane it started.
    const ownPaneKey = makePaneKey(create.identity.tabId, create.identity.leafId)
    if (await this.isProviderSessionLiveInAnotherPane(session, ownPaneKey)) {
      return refuse('held_elsewhere')
    }
    const records = Object.values(
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey ?? {}
    ).filter(
      (record) =>
        worktreeIdsEqual(record.worktreeId, worktreeId) &&
        record.agent === session.agent &&
        agentProviderSessionsEqual(record.agent, record.providerSession, session.providerSession)
    )
    if (records.some((record) => !this.isPaneOwnedResumeRecord(record))) {
      return refuse('window_owns_wake')
    }
    // Why: a session two panes record is never resumed automatically (resolvePaneOwnedResumeStartup).
    if (records.length > 1) {
      return refuse('held_elsewhere')
    }
    const record = records[0]
    const resume = this.resolveMobileSessionResumeCommand(workspace, {
      ...session,
      launchConfig: record?.launchConfig
    })
    if (!resume) {
      return refuse('no_resume_command')
    }
    // Why: pane-owned before the spawn, so another resume of the record cannot run it twice.
    if (record && isUnclaimedRunningSleepRecord(record)) {
      if (!(await this.claimSleepRecord(worktreeId, record))) {
        return refuse('held_elsewhere')
      }
    }
    if (request.signal?.aborted) {
      return refuse('aborted')
    }
    // Why: the create publishes onto the worktree's snapshot, which must hold its saved tabs first.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Why the runtime-owned create: it spawns with the runtime the command was quoted for, and a
    // window-made create can time out here while its agent still starts.
    const created = await this.createRuntimeOwnedMobileSessionTerminal(
      worktreeId,
      false,
      undefined,
      {
        command: resume.command,
        env: resume.env,
        startupCommandDelivery: resume.startupCommandDelivery,
        launchConfig: resume.launchConfig,
        launchAgent: resume.launchAgent,
        launchRuntime: resume.launchRuntime,
        resumeProviderSession: resume.resumeProviderSession,
        spawnIntent: 'user-resume',
        identity: create.identity,
        createMutation: { clientIdentity: 'agent-session-resume', id: request.mutationId },
        onPtySpawnDispatched: create.onPtySpawnDispatched,
        onPtyCreated: create.onPtyCreated,
        signal: request.signal
      }
    )
    const { tab } = created
    if (tab.status !== 'ready' || !tab.ptyId) {
      return refuse('create_failed')
    }
    return {
      ok: true,
      handle: tab.terminal,
      paneKey: makePaneKey(tab.parentTabId, tab.leafId),
      ptyId: tab.ptyId
    }
  }
}
