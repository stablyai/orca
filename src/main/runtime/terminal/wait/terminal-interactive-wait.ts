import { heldLaunchConfig } from '../launch/launch-evidence'
import type { TerminalIdentityReadContext } from '../query/terminal-identity-read-context'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from '../adoption/adopt-terminal-orphans-from-inventory'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalAgentStatusSnapshot } from '../query/runtime-terminal-agent-status-query'
import type {
  TerminalInteractiveWaitEvidence,
  TerminalWaitPermissionInputs,
  TerminalWaitStatusEvidence
} from './terminal-wait-permission'
import type { AgentLaunchScope } from '../../session-tabs/structured-session-tab-restoration'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './terminal-interactive-probe-budget'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  activeSessionWorkspaceId,
  activeWorkspaceSelectorScopes,
  resolveRemoteWorkspaceContext,
  type ActiveWorkspaceContext,
  type PairedWorkspaceContextSource
} from './active-worktree-context-fallback'
import type { ExactWorkerProviderSession } from '../../../../shared/orchestration/workers/orchestration-worker-output'
import { selectExactWorkerProviderSession } from '../../orchestration/workers/transcripts/worker-provider-session'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveConfiguredWorkerAgent } from '../../orchestration/workers/launch/configured-worker-agent-selector'
import { resolveAgentLaunchRuntime } from '../launch/agent-launch-scope-runtime'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { resolveOpenCodeModelLaunchRoute } from '../../../opencode/model-launch/opencode-model-startup-plan'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'

export abstract class OrcaRuntimeWithGetTerminalInteractiveWait extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  protected abstract getTerminalAgentStatusPtyId(handle: string): string

  protected abstract getTerminalWaitPermissionInputs(
    handle: string,
    ptyId: string,
    waitTextOverride?: string
  ): TerminalWaitPermissionInputs

  protected abstract resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: TerminalWaitStatusEvidence,
    lifecycle: TerminalWaitPermissionInputs['lifecycle'],
    observedOnScreen?: boolean
  ): RuntimeTerminalWaitBlockedReason | null

  protected abstract readTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined>

  abstract getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus>

  protected abstract getPtyRecordForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): RuntimePtyWorktreeRecord | null

  protected abstract getOrchestrationDbIfAvailable(): OrchestrationDb | null

  protected abstract getAgentLaunchPlatformForWorkspace(scope: AgentLaunchScope): NodeJS.Platform

  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let evidence: TerminalInteractiveWaitEvidence | undefined
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
      const read = this.readTerminalInteractiveWaitEvidence(handle, ptyId)
      // Why not always await: a hook-status probe must start in this tick so concurrent queries share it.
      evidence = read instanceof Promise ? await read : read
    } catch {
      return undefined
    }
    if (!evidence) {
      return undefined
    }
    const { terminal, explicitStatus, promptReason } = evidence
    if (promptReason) {
      return {
        source: 'prompt-text',
        reason: promptReason,
        ...(terminal.waitBlockedAt !== null ? { since: terminal.waitBlockedAt } : {})
      }
    }
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { source: 'title' }
    }
    if (explicitStatus?.status !== 'permission') {
      return evidence.unconfirmed ? undefined : null
    }
    const status = await withTimeout(
      this.probeAgentStatusOncePerPty(handle, ptyId),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      undefined
    )
    if (!status) {
      return undefined
    }
    return status.isRunningAgent && status.status === 'permission'
      ? { source: 'hook', since: explicitStatus.updatedAt }
      : null
  }

  protected probeAgentStatusOncePerPty(
    handle: string,
    ptyId: string
  ): Promise<RuntimeTerminalAgentStatus | undefined> {
    const inFlight = this.interactiveWaitProbesByPtyId.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = this.getTerminalAgentStatus(handle)
      .catch(() => undefined)
      .finally(() => {
        if (this.interactiveWaitProbesByPtyId.get(ptyId) === probe) {
          this.interactiveWaitProbesByPtyId.delete(ptyId)
        }
      })
    this.interactiveWaitProbesByPtyId.set(ptyId, probe)
    return probe
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    return leaf?.worktreeId ?? this.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  /** Paired servers' workspace rows the desktop holds; set while relay hosts are attached. */
  private pairedWorkspaceContexts: PairedWorkspaceContextSource | null = null

  setPairedWorkspaceContextSource(source: PairedWorkspaceContextSource | null): void {
    this.pairedWorkspaceContexts = source
  }

  /** The focused workspace, preferring stored selection, then the renderer graph. */
  async resolveActiveWorktreeContext(): Promise<ActiveWorkspaceContext | null> {
    const session = this.store?.getWorkspaceSession?.()
    const hostId = session?.activeWorkspaceExecutionHostId ?? undefined
    let worktreeId = activeSessionWorkspaceId(session)
    if (!worktreeId && this.graphStatus === 'ready') {
      for (const tab of this.tabs.values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    for (const scope of activeWorkspaceSelectorScopes(hostId)) {
      try {
        const resolved = await this.resolveWorkspaceSelector(`id:${worktreeId}`, scope)
        return {
          worktreeId: resolved.id,
          ...(resolved.identity ? { identityKey: resolved.identity.key } : {}),
          path: resolved.git.path,
          branch: resolved.git.branch,
          displayName: resolved.displayName
        }
      } catch {
        // A remote worktree is not in the local catalog; project what the stored row knows.
      }
    }
    return resolveRemoteWorkspaceContext(
      this.store,
      this.pairedWorkspaceContexts,
      worktreeId,
      hostId
    )
  }

  getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null {
    const paneKey = this.getTerminalPaneKey(handle)
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return null
    }
    let connectionId: string | null | undefined
    let launchToken: string | null | undefined
    let wslDistro: string | undefined
    let pty: RuntimePtyWorktreeRecord | undefined
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
      // A WSL pane's PTY is local, so its hook events only match once the distro is supplied.
      wslDistro = pty?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
    }
    const session = selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      wslDistro,
      observedAfter,
      statuses: this.publicPaneStatusFn?.(paneKey) ?? []
    })
    const launchConfig = session ? heldLaunchConfig(pty, session.agent) : undefined
    return session && launchConfig ? { ...session, launchConfig } : session
  }

  resolveOrchestrationAgentLauncher(
    selector: string,
    platform: NodeJS.Platform = process.platform,
    shell?: AgentStartupShell
  ): TuiAgent | undefined {
    return resolveConfiguredWorkerAgent(
      selector,
      this.store?.getSettings().agentCmdOverrides ?? {},
      platform,
      shell
    )
  }

  async resolveOrchestrationAgentLauncherForTarget(
    selector: string,
    target: { repo?: string; worktree?: string }
  ): Promise<TuiAgent | undefined> {
    if (isTuiAgent(selector)) {
      return selector
    }
    const repo = target.repo ? await this.resolveRepoSelector(target.repo) : null
    // SAFETY: Forward an absent target unchanged; the existing resolver owns validation.
    const workspace = repo
      ? { repo, path: repo.path, connectionId: getRepoRoutingConnectionId(repo) }
      : await this.resolveTerminalWorkspaceLaunchScope(target.worktree!)
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const shell = resolveStartupShell(
      platform,
      resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote: Boolean(workspace.connectionId),
        terminalWindowsShell: this.store?.getSettings().terminalWindowsShell
      })
    )
    return this.resolveOrchestrationAgentLauncher(selector, platform, shell)
  }

  async probeOrchestrationOpenCodeModelLaunchSupport(target: {
    worktree?: string
    model?: string
  }): Promise<boolean> {
    if (!target.model || !target.worktree) {
      return false
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(target.worktree)
    const executionRepo = workspace?.repo
    if (
      workspace?.connectionId ||
      (executionRepo?.executionHostId && executionRepo.executionHostId !== 'local')
    ) {
      return false
    }
    const store = this.requireStore()
    const path = workspace?.path
    if (!path) {
      return false
    }
    // The launch's own platform, and `isWsl` from the path alone, as main read it.
    let launchRuntime
    try {
      launchRuntime = resolveAgentLaunchRuntime(store, workspace, undefined, 'opencode')
    } catch {
      return false
    }
    if (
      !target.model.trim() ||
      launchRuntime.platform !== process.platform ||
      parseWslUncPath(path)
    ) {
      return false
    }
    await resolveOpenCodeModelLaunchRoute({
      inputs: resolveAgentStartupPlanInputs({
        agent: 'opencode',
        settings: store.getSettings(),
        platform: launchRuntime.platform,
        isRemote: false,
        shell: undefined,
        sessionOptions: { model: target.model }
      }),
      cwd: path,
      hostIdentity: this.getRuntimeId()
    })
    return true
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    const settings = this.store?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Agent launcher ${agent} is disabled or unavailable.`
      )
    }
  }
}
