import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as SessionTabsPublication } from '../../session-tabs/publication/session-tabs-change-publication'
import { OrcaRuntimeWithFailedStartPanes } from './failed-start-pane'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/creation/launch-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeTerminalPresentation } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { SpawnIntent } from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import {
  type RuntimeNavigationTarget,
  navigationTargetsHost
} from '../../../../shared/remote-runtime/session-graph/runtime-navigation'

import {
  isTeammateTabList,
  type TabPerson,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import { randomUUID } from 'node:crypto'
import { mintServePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import { personTabId, type PersonSurface } from '../../session-tabs/person/person-tab-list-snapshot'
import { seedResumeLaunchIdentity } from '../../../ipc/pty/pane/resume-launch-identity'
// Allow lost-response reconnect retries for one minute; later intentional resumes fork fresh.
const MOBILE_TERMINAL_CREATE_RESULT_TTL_MS = 60_000

/** A paired client's terminal create request. */
export type MobileTerminalCreateOptions = {
  terminalImageViewerSupported?: boolean
  afterTabId?: string
  sourceChatFork?: { sessionId: string }
  targetGroupId?: string
  command?: string
  shellOverride?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  agent?: TuiAgent
  agentPrompt?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  trustWorktreeId?: string
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  clientNavigationId?: string
  clientMutationId?: string
  supportsSplitGroupPlacement?: boolean
  /** A teammate's create in their agent's Home: their own list holds it, never the host's. */
  personList?: TeammateTabListKey
  signal?: AbortSignal
}

export type OwnedMobileTerminalCreateOptions = {
  /** A paired client's own create or tab open; without it a stopped WSL distro holds the start. */
  wslUserAct?: true
  command?: string
  shellOverride?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  identity?: { tabId: string; leafId: string; sessionId?: string }
  createMutation?: { clientIdentity: string; id: string }
  launchAgent?: TuiAgent
  trustWorktreeId?: string
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  afterDesktopTabId?: string
  presentation?: RuntimeTerminalPresentation
  supportsSplitGroupPlacement?: boolean
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  resumeOrigin?: 'saved'
  spawnIntent?: SpawnIntent
  launchRuntime?: AgentLaunchRuntime
  signal?: AbortSignal
  refuseSleptWorktree?: boolean
  resumesSleepingRecord?: true
  reopensPane?: true
  /** See TerminalCreateOptions; a create that throws before it proves nothing spawned. */
  onPtySpawnDispatched?: () => void
  /** The PTY this create produced, reported before publication can fail. */
  onPtyCreated?: (ptyId: string, result: RuntimeTerminalCreate) => void
}

export abstract class OrcaRuntimeWithCreateMobileSessionTerminal extends OrcaRuntimeWithFailedStartPanes {
  protected abstract runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts?: MobileTerminalCreateOptions
  ): Promise<RuntimeMobileSessionCreateTerminalResult>

  protected abstract getValidatedExplicitWorktreeIdSelector(
    selector: string | undefined
  ): string | null

  abstract getExplicitSessionWorktreeIdSelector(selector: string | undefined): string | null

  protected abstract getMobileSessionTabsForWorktree(
    ...args: Parameters<SessionTabsPublication['getMobileSessionTabsForWorktree']>
  ): ReturnType<SessionTabsPublication['getMobileSessionTabsForWorktree']>

  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      sourceChatFork?: { sessionId: string }
      targetGroupId?: string
      command?: string
      shellOverride?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchAgent?: TuiAgent
      trustWorktreeId?: string
      terminalImageViewerSupported?: boolean
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      // Older mobile clients optimistically append; preserve that placement until they advertise
      // split-group ordering support.
      supportsSplitGroupPlacement?: boolean
      /** Who opens it: a teammate's in their agent's Home goes to their own list. */
      person: TabPerson
      signal?: AbortSignal
    }
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const navigation = opts.navigation ?? 'all'
    const select = opts.select ?? opts.activate !== false
    const resolveWorktreeId = async () =>
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const list =
      opts.person === 'owner' ? 'host' : this.homeTabListOf(opts.person, await resolveWorktreeId())
    const personList = isTeammateTabList(list) ? list : undefined
    const runOpts = {
      ...opts,
      // A teammate's own list picks it for their devices alone; nothing reaches the host's window.
      activate: personList ? select : select && navigationTargetsHost(navigation),
      ...(personList ? { personList } : {})
    }
    const mutationId = opts.clientMutationId
    const startRun = async (): Promise<RuntimeMobileSessionCreateTerminalResult> => {
      const created = await this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
      this.seedMobileResumeIdentity(created, opts)
      return created
    }
    let result: RuntimeMobileSessionCreateTerminalResult
    if (!mutationId) {
      result = await startRun()
    } else {
      // Idempotency belongs to the caller; paired devices may reuse mutation ids independently.
      const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
      // Join in-flight creates and briefly retain successes for lost-response retries; drop failures so a genuine retry can start fresh.
      const inflight = this.mobileTerminalCreateByMutationId.get(mutationKey)
      const run = inflight ?? startRun()
      if (!inflight) {
        this.mobileTerminalCreateByMutationId.set(mutationKey, run)
        const drop = (): void => {
          if (this.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
            this.mobileTerminalCreateByMutationId.delete(mutationKey)
          }
        }
        void run.then(() => {
          setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
        }, drop)
      }
      result = await run
    }
    if (select && !personList) {
      const worktreeId = await resolveWorktreeId()
      this.applyMobileSessionTabNavigation(
        await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
          includeAgentSenders: false
        }),
        result.tab.id,
        navigation,
        opts.clientNavigationId
      )
    }
    return result
  }

  /** A teammate's terminal in their agent's Home: it runs on the host, held by their own list from
   *  before it starts. Its PTY binds to that tab as it registers, so its record is stamped (`holder`)
   *  and no host list or window ever places it. */
  protected async createPersonTerminal(
    person: TeammateTabListKey,
    workspace: TerminalWorkspaceLaunchScope,
    cwd: string | undefined,
    startup: MobileTerminalCommand,
    opts: MobileTerminalCreateOptions
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    // Local daemons reattach it after a restart by this id; SSH hosts name their own. Their tab holds
    // it before it starts, so whichever path records the process first stamps it as theirs.
    const sessionId = workspace.connectionId
      ? null
      : mintServePtySessionId(workspace.id, randomUUID())
    const surface = {
      kind: 'terminal' as const,
      parentTabId: randomUUID(),
      leafId: randomUUID(),
      ptyId: sessionId
    }
    const tabId = personTabId(surface)
    const activate = opts.activate !== false
    this.personSessionTabs.openSurface(person, workspace.id, surface, activate)
    try {
      const created = await this.createTerminal(`id:${workspace.id}`, {
        focus: false,
        presentation: 'background',
        deferMobileSessionPublish: true,
        wslUserAct: true,
        tabId: surface.parentTabId,
        leafId: surface.leafId,
        holder: person,
        ...(sessionId ? { sessionId, isNewSession: true } : {}),
        command: startup.command,
        ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
        cwd,
        env: startup.env,
        envToDelete: startup.envToDelete,
        startupCommandDelivery: startup.startupCommandDelivery,
        ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
        ...(startup.launchAgent ? { launchAgent: startup.launchAgent } : {}),
        ...(startup.launchRuntime ? { launchRuntime: startup.launchRuntime } : {}),
        ...(opts.trustWorktreeId ? { trustWorktreeId: opts.trustWorktreeId } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        signal: opts.signal
      })
      if (!created.ptyId) {
        throw new Error('terminal_handle_stale')
      }
    } catch (error) {
      // Closing the tab stops its process when it registered; one that never did never started here.
      this.closePersonSessionTab(person, workspace.id, tabId)
      throw error
    }
    // It exited before it could show: its exit already took it off their list.
    const held = (candidate: PersonSurface) =>
      candidate.kind === 'terminal' && candidate.parentTabId === surface.parentTabId
    if (!this.personSessionTabs.holderOfSurface(held)) {
      throw new Error('terminal_handle_stale')
    }
    const shown = this.showPersonSurface(person, workspace.id, surface, {
      activate,
      clientNavigationId: opts.clientNavigationId
    })
    const tab = shown.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return { tab, publicationEpoch: shown.publicationEpoch, snapshotVersion: shown.snapshotVersion }
  }

  /** A client-typed resume (phone Session History) names its conversation before the agent does. */
  private seedMobileResumeIdentity(
    created: RuntimeMobileSessionCreateTerminalResult,
    opts: { resumeProviderSession?: AgentProviderSessionMetadata; launchAgent?: TuiAgent }
  ): void {
    if (!opts.resumeProviderSession || !created.tab.terminal) {
      return
    }
    const pty = this.getLivePtyForHandle(created.tab.terminal)?.pty
    const paneKey = this.paneOfPty(pty).paneKey
    // Why: an SSH pane's status rows belong to the relay on that host.
    if (!pty || !paneKey || pty.connectionId) {
      return
    }
    seedResumeLaunchIdentity({
      paneKey,
      launchAgent: opts.launchAgent,
      resumeProviderSession: opts.resumeProviderSession,
      worktreeId: pty.worktreeId,
      // This resume owns the new pane from time zero; reconciled live retries must retain the agent's own report.
      launchedAt: 0
    })
  }
}
