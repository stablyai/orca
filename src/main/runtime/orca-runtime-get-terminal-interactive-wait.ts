// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from './orca-runtime-adopt-terminal-orphans-from-inventory'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait
} from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import { withTimeout } from './runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectLocalManagedAgentCliPresence } from '../agent-hooks/local-agent-cli-presence'
import { getManagedAgentHookTarget } from '../../shared/managed-agent-hook-targets'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'
import { extractExecutableToken } from '../../shared/managed-agent-command-token'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../shared/tui-agent-detection-commands'
import { isCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'

export class OrcaRuntimeWithGetTerminalInteractiveWait extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let terminal: RuntimeTerminalAgentStatusSnapshot
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
      terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId)
    } catch {
      return undefined
    }
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    const promptReason = this.resolveAuthoritativeTerminalWaitPermission(
      terminal,
      explicitStatus,
      this.agentPromptLifecycleByPtyId.get(ptyId)
    )
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
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
      connectionId = undefined
      launchToken = undefined
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  async validateOrchestrationAgentLauncherForRepo(
    agent: TuiAgent,
    repoSelector: string
  ): Promise<void> {
    this.validateOrchestrationAgentLauncher(agent)
    const settings = this.store?.getSettings()
    if (!settings) {
      return
    }
    const repo = await this.showRepo(repoSelector)
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    const localRuntimeKind =
      projectRuntime?.status === 'resolved' ? projectRuntime.runtime.kind : undefined
    let detected: string[]
    if (repo.connectionId) {
      const override = extractExecutableToken(settings.agentCmdOverrides?.[agent])
      const config = TUI_AGENT_CONFIG[agent]
      const commands = override
        ? [
            ...KNOWN_TUI_AGENT_DETECTION_COMMANDS,
            {
              id: agent,
              cmd: override,
              ...(config.detectRequiredCommands
                ? { requiredCommands: config.detectRequiredCommands }
                : {}),
              ...(config.detectUnsupportedRuntimes
                ? { unsupportedRuntimes: config.detectUnsupportedRuntimes }
                : {})
            }
          ]
        : undefined
      detected = await detectRemoteAgents({
        connectionId: repo.connectionId,
        commands,
        requireAvailable: true
      })
    } else {
      detected = await detectInstalledAgentsWithShellPathHydration(
        { projectRuntime },
        { failOnProbeError: true }
      )
      const override = extractExecutableToken(settings.agentCmdOverrides?.[agent])
      if (
        !detected.includes(agent) &&
        override &&
        projectRuntime?.status === 'resolved' &&
        projectRuntime.runtime.kind === 'wsl'
      ) {
        const found = await detectWslCommandsOnPath(
          { distro: projectRuntime.runtime.distro },
          [override],
          { failOnProbeError: true }
        )
        if (found.has(override)) {
          return
        }
      }
      if (
        !detected.includes(agent) &&
        override &&
        projectRuntime?.status !== 'repair-required' &&
        localRuntimeKind !== 'wsl'
      ) {
        const env = {
          ...(buildLocalPreflightEnv() ?? process.env),
          ...settings.agentDefaultEnv?.[agent]
        }
        const pathEnv = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
        const target = getManagedAgentHookTarget(agent)
        if (target) {
          const presence = await detectLocalManagedAgentCliPresence([target], settings, { pathEnv })
          if (presence[agent]?.state === 'found') {
            return
          }
        } else if (await isCommandOnLocalPath(override, { env, cwd: repo.path })) {
          return
        }
      }
    }
    const usesClaudeTeamsFallback =
      agent === 'claude-agent-teams' &&
      detected.includes('claude') &&
      (this.getAgentLaunchPlatformForRepo(repo) === 'win32' ||
        (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'))
    if (!detected.includes(agent) && !usesClaudeTeamsFallback) {
      throw new OrchestrationError(
        'agent_not_available',
        `Agent launcher ${agent} is not installed on the execution host.`
      )
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
