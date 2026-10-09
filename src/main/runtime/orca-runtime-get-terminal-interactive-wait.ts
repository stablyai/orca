// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from './orca-runtime-adopt-terminal-orphans-from-inventory'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../shared/agent-detection'
import { withTimeout } from './runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { OrchestrationError } from './orchestration/orchestration-error'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveStartupShell, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveConfiguredWorkerAgent } from './orchestration/configured-worker-agent-selector'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'

import { prepareOpenCodeModelStartupInputs } from '../opencode/opencode-model-startup-plan'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'

export class OrcaRuntimeWithGetTerminalInteractiveWait extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let inputs: {
      terminal: RuntimeTerminalAgentStatusSnapshot
      lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
    }
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
    } catch {
      return undefined
    }
    // Why: tui-idle reads the screen only once its model has applied every received byte.
    await this.headlessTerminals.get(ptyId)?.writeChain
    let promptReason: RuntimeTerminalWaitBlockedReason | null
    try {
      inputs = this.getTerminalWaitPermissionInputs(handle, ptyId)
      promptReason = this.readTuiIdleBlockedReason(handle)
    } catch {
      return undefined
    }
    const { terminal } = inputs
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    // Why text-shown only: a hook wait with no dialog text keeps its hook provenance below.
    if (promptReason && this.terminalShowsBlockedText(ptyId, terminal.waitText)) {
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
      return null
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

  /** Read-only context of the worktree the user is focused on, for plugin
   *  panels (workspace.readContext). Prefers the persisted session focus and
   *  falls back to the last-focused pane's worktree; null when neither
   *  resolves so panels degrade instead of erroring. */
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
      const resolved = await this.resolveWorktreeSelector(`id:${worktreeId}`)
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
      return null
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
    const workspace = repo
      ? { repo, path: repo.path, connectionId: repo.connectionId }
      : await this.resolveTerminalWorkspaceLaunchScope(target.worktree)
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
    const settings = store.getSettings()
    const path = workspace?.path
    const unc = path ? parseWslUncPath(path) : null
    const projectRuntime = executionRepo
      ? resolveLocalProjectRuntimeForRepo(store, executionRepo)
      : null
    if (projectRuntime?.status === 'repair-required') {
      return false
    }
    const wsl = unc
      ? { distro: unc.distro }
      : projectRuntime?.runtime.kind === 'wsl'
        ? { distro: projectRuntime.runtime.distro }
        : undefined
    if (!path) {
      return false
    }
    try {
      await prepareOpenCodeModelStartupInputs({
        inputs: resolveAgentStartupPlanInputs({
          agent: 'opencode',
          settings,
          platform: wsl ? 'linux' : process.platform,
          isRemote: false,
          sessionOptions: { model: target.model }
        }),
        cwd: path,
        isWsl: Boolean(wsl),
        hostIdentity: this.getRuntimeId()
      })
      return true
    } catch {
      return false
    }
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
