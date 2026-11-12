import { extractLeadingEnvAssignments } from '../../../../../shared/command-environment'
import { getCommandTokenPathBasename } from '../../../../../shared/command-token-scanner'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  resolveStartupShell,
  type AgentStartupShell,
  tokenizeStartupCommand
} from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { OrchestrationError } from '../../orchestration-error'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RuntimeStore } from '../../../construction/runtime-store-contract'
import { agentLaunchPlatformForScope } from '../../../terminal/launch/agent-launch-scope-runtime'
import { getRepoRoutingConnectionId } from '../../../../../shared/execution-host'
import { resolveLocalWindowsAgentStartupShell } from '../../../../../shared/windows-terminal-shell'

export function resolveConfiguredWorkerAgent(
  selector: string,
  overrides: Partial<Record<TuiAgent, string>>,
  platform: NodeJS.Platform = process.platform,
  shell?: AgentStartupShell
): TuiAgent | undefined {
  if (isTuiAgent(selector)) {
    return selector
  }
  const matches: TuiAgent[] = []
  for (const [agent, command] of Object.entries(overrides)) {
    if (!isTuiAgent(agent) || !command) {
      continue
    }
    const parsed = tokenizeStartupCommand(command, resolveStartupShell(platform, shell))
    // A command wrapper cannot attest which CLI grammar its arguments implement.
    if (
      !parsed.ok ||
      parsed.tokens.length !== 1 ||
      parsed.spans.some((span) => span.divergesFromShell)
    ) {
      continue
    }
    if (extractLeadingEnvAssignments(parsed.tokens).env) {
      continue
    }
    const executable = parsed.tokens[0]
    const name = getCommandTokenPathBasename(executable).replace(/\.(?:exe|cmd|bat)$/i, '')
    if (name === selector) {
      matches.push(agent)
    }
  }
  if (matches.length > 1) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Agent command ${selector} is configured for multiple launchers. Use a canonical agent ID.`
    )
  }
  return matches[0]
}

export async function resolveConfiguredWorkerAgentForTarget(
  runtime: Pick<
    OrcaRuntimeService,
    'showRepo' | 'resolveTerminalWorkspaceLaunchScope' | 'resolveOrchestrationAgentLauncher'
  >,
  selector: string,
  target: { repo?: string; worktree?: string },
  store: RuntimeStore | null | undefined
): Promise<TuiAgent | undefined> {
  if (isTuiAgent(selector)) {
    return selector
  }
  const repo = target.repo ? await runtime.showRepo(target.repo) : null
  // SAFETY: Forward an absent target unchanged; the existing resolver owns validation.
  const workspace = repo
    ? { repo, path: repo.path, connectionId: getRepoRoutingConnectionId(repo) }
    : await runtime.resolveTerminalWorkspaceLaunchScope(target.worktree!)
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  const platform = agentLaunchPlatformForScope(store, {
    id: '',
    folderWorkspace: null,
    ...workspace,
    connectionId: workspace.connectionId ?? null
  })
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: Boolean(workspace.connectionId),
      terminalWindowsShell: store.getSettings().terminalWindowsShell
    })
  )
  return runtime.resolveOrchestrationAgentLauncher(selector, platform, shell)
}
