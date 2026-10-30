import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import { resolveStructuredWorkerAuthority } from '../../structured-worker-authority'
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from '../adoption/adopt-terminal-orphans-from-inventory'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalAgentStatusSnapshot } from '../../runtime-terminal-agent-status-query'
import type {
  TerminalInteractiveWaitEvidence,
  TerminalWaitPermissionInputs,
  TerminalWaitStatusEvidence
} from './terminal-wait-permission'

import type { AgentLaunchScope } from '../../session-tabs/structured-session-tab-restoration'
import { withTimeout } from '../../runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../../orca-runtime-core'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { ExactWorkerProviderSession } from '../../../../shared/orchestration-worker-output'
import { selectExactWorkerProviderSession } from '../../orchestration/worker-provider-session'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { resolveConfiguredWorkerAgent } from '../../orchestration/configured-worker-agent-selector'
import { resolveAgentLaunchRuntime } from '../../agent-launch-scope-runtime'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { resolveOpenCodeModelLaunchRoute } from '../../../opencode/opencode-model-startup-plan'

import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

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

  protected abstract getLeafKey(tabId: string, leafId: string): string

  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

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

  // Prefer stored workspace selection, then the current renderer graph.
  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
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
    try {
      const resolved = await this.resolveWorkspaceSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    const structured = resolveStructuredWorkerAuthority(
      handle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      return structured.identity.processIncarnation
    }
    const live = this.getLivePtyForHandle(handle)
    const record = live?.record ?? this.handles.get(handle)
    if (!record?.ptyId) {
      return this.getOrchestrationCompatibilitySshTerminal(handle)?.processIncarnation ?? null
    }
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(record.ptyId)?.incarnationId
    if (incarnationId) {
      return `${record.ptyId}:${incarnationId}`
    }
    // Why: legacy providers may omit process incarnation; retain the prior restart-degraded fence.
    return `${this.runtimeId}:${record.ptyId}:${record.ptyGeneration}`
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
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
      // A WSL pane's PTY is local, so its hook events only match once the distro is supplied.
      wslDistro = pty?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
      connectionId = undefined
      launchToken = undefined
      wslDistro = undefined
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      wslDistro,
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? []
    })
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
