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
import { WslHostWindowsOnlyAgentError } from '../../wsl-host-agent-terminal-launch'

export type AgentSessionResumeRefusal =
  | 'window_owns_wake'
  | 'held_elsewhere'
  | 'no_resume_command'
  | 'aborted'
  | 'create_failed'
  | 'windows_only_cli'

export type AgentSessionResumeResult =
  | { ok: true; handle: string; paneKey: string; ptyId: string }
  | { ok: false; reason: Exclude<AgentSessionResumeRefusal, 'windows_only_cli'> }
  /** A WSL host found only a Windows copy of the agent CLI; message says how to fix it. */
  | { ok: false; reason: 'windows_only_cli'; message: string }

export abstract class OrcaRuntimeWithResumeAgentSessionInWorkspace extends OrcaRuntimeWithAgentSessionResumeOwnership {
  protected abstract createRuntimeOwnedMobileSessionTerminal(
    ...args: Parameters<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>
  ): ReturnType<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>

  /** Resume the recorded conversation into a fresh bound pane or refuse; never substitute a plain shell or fresh agent. */
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
    const refuse = (
      reason: Exclude<AgentSessionResumeRefusal, 'windows_only_cli'>
    ): AgentSessionResumeResult => ({
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
    // Provider session ids name transcripts only on their reporting execution host.
    if (getConnectionExecutionHostId(workspace.connectionId) !== request.captureHostId) {
      return refuse('no_resume_command')
    }
    // Retries reconcile this request's pane instead of spawning another.
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
    // A session recorded by two panes cannot resume automatically (resolvePaneOwnedResumeStartup).
    if (records.length > 1) {
      return refuse('held_elsewhere')
    }
    const record = records[0]
    let resume
    try {
      resume = this.resolveMobileSessionResumeCommand(workspace, {
        ...session,
        launchConfig: record?.launchConfig
      })
    } catch (error) {
      if (error instanceof WslHostWindowsOnlyAgentError) {
        return { ok: false, reason: 'windows_only_cli', message: error.message }
      }
      throw error
    }
    if (!resume) {
      return refuse('no_resume_command')
    }
    // Claim pane ownership before spawn to prevent a second resume writer.
    if (record && isUnclaimedRunningSleepRecord(record)) {
      if (!(await this.claimSleepRecord(worktreeId, record))) {
        return refuse('held_elsewhere')
      }
    }
    if (request.signal?.aborted) {
      return refuse('aborted')
    }
    // Seed saved tabs before create publishes onto the workspace snapshot.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Runtime-owned create uses the quoting host; a window create may time out while its agent still starts.
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
