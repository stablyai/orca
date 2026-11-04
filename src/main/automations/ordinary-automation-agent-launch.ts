import type { AgentLaunchResult as AgentLaunchPublishedSurface } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
import type { AgentLaunchSurfaceExecution } from '../agent-launch/agent-launch-execution'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { HeadlessAutomationAgentLaunch } from './headless-automation-agent-launch'

const TERMINAL_ONLY_MESSAGE = 'An automation starts a terminal agent only.'
type LaunchedTerminal = {
  handle: string
  tabId?: string | null
  paneKey?: string | null
  ptyId?: string | null
}
export async function launchOrdinaryTerminalAgent(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'trigger'>
    target: Extract<AutomationRunTargetResult, { ok: true }>
    runs: readonly AutomationRun[]
  }
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const selectedTarget =
    automation.workspaceMode === 'existing'
      ? await runtime.resolveManagedTerminalWorkspaceTarget(
          `id:${requireWorkspaceId(automation)}`,
          parseWorkspaceKey(automation.workspaceId ?? '')?.type === 'folder'
            ? undefined
            : getRepoExecutionHostId(target.repo),
          false
        )
      : undefined
  const selectedWorkspace = selectedTarget?.managedWorktree
  if (automation.workspaceMode === 'existing' && !selectedWorkspace) {
    throw new Error('The target workspace is no longer available.')
  }
  const agent = automation.agentId
  const text = automation.prompt?.trim()
  let workspace: { id: string; displayName: string | null } | undefined
  let terminal: LaunchedTerminal | undefined
  const execution: AgentLaunchSurfaceExecution = {
    runtime,
    intent: {
      agent,
      // The workspace factory supplies create arguments from the automation.
      target:
        automation.workspaceMode === 'new_per_run'
          ? { kind: 'create-worktree', create: {} }
          : { kind: 'existing', worktree: requireWorkspaceId(automation) },
      ...(text ? { prompt: { text, delivery: 'submit' as const } } : {})
    },
    terminalOnly: true,
    workspaces: {
      createWorktree: async ({ startupAgent, startupPrompt }) => {
        if (startupAgent === undefined) {
          throw new Error(TERMINAL_ONLY_MESSAGE)
        }
        const { startupPrompt: _prompt, ...create } = buildHeadlessAutomationWorktreeCreateArgs({
          automation,
          run,
          repo: target.repo
        })
        let startupTerminalCreation: RuntimeTerminalCreate | undefined
        const created = await runtime.createManagedWorktree({
          onStartupTerminalCreated: (terminal) => {
            startupTerminalCreation = terminal
          },
          ...create,
          startupAgent,
          ...(startupPrompt ? { startupPrompt } : {})
        })
        workspace = {
          id: created.worktree.id,
          displayName: created.worktree.displayName ?? null
        }
        const startup = created.startupTerminal
        if (!startup?.handle) {
          throw new Error(
            created.warning || 'Automation workspace was created, but no agent terminal started.'
          )
        }
        terminal = { ...startup, handle: startup.handle }
        return {
          worktreeId: created.worktree.id,
          startupTerminalHandle: startup.handle,
          startupTerminalCreation,
          ...(startup.paneKey ? { startupTerminalPaneKey: startup.paneKey } : {}),
          // Creation stages long prompts while keeping them on the launch command.
          ...(startupPrompt ? { promptRodeLaunchCommand: true } : {})
        }
      }
    },
    surfaces: {
      createStructuredSession: () => {
        throw new Error(TERMINAL_ONLY_MESSAGE)
      },
      createTerminalAgent: async ({ worktreeId, startupPrompt }) => {
        const resolved = selectedWorkspace
        if (!resolved) {
          throw new Error('The target workspace is no longer available.')
        }
        const launched = await runtime.launchAgentTerminal(
          `id:${worktreeId}`,
          {
            agent,
            prompt: startupPrompt ?? '',
            title: run.title,
            suppressStartupUpdatePrompt: true,
            ...(automation.extraAgentArgs ? { extraAgentArgs: automation.extraAgentArgs } : {}),
            // Run now is the user's act and may start a stopped WSL distro; a scheduled run never does.
            ...(run.trigger === 'scheduled' ? {} : { wslUserAct: true as const })
          },
          {
            worktree: resolved,
            repo: target.repo,
            folderWorkspace: selectedTarget?.scope.folderWorkspace ?? undefined
          }
        )
        terminal = launched
        workspace = { id: launched.worktreeId, displayName: resolved.displayName ?? null }
        return {
          handle: launched.handle,
          terminalCreation: launched,
          ...(launched.paneKey ? { paneKey: launched.paneKey } : {}),
          ...(startupPrompt ? { promptRodeLaunchCommand: true } : {})
        }
      },
      deliverTerminalPrompt: ({ handle, prompt, terminalCreation }) =>
        runtime.deliverStartupFollowup(handle, { agent, prompt: prompt.text }, { terminalCreation })
    }
  }
  await launchUntilPublished(execution)
  if (!workspace || !terminal) {
    throw new Error('Automation agent launch did not report its terminal.')
  }
  return {
    workspaceId: workspace.id,
    workspaceDisplayName: workspace.displayName,
    terminalHandle: terminal.handle,
    terminalSessionId: terminal.tabId ?? null,
    terminalPaneKey: terminal.paneKey ?? null,
    terminalPtyId: terminal.ptyId ?? null
  }
}

/** Return on terminal publication; post-start prompt delivery may still be pending. */
function launchUntilPublished(
  execution: AgentLaunchSurfaceExecution
): Promise<AgentLaunchPublishedSurface> {
  return new Promise((resolve, reject) => {
    let published = false
    executeAgentLaunch({
      ...execution,
      onSurfacePublished: (surface) => {
        published = true
        resolve(surface)
      }
    }).catch((error: unknown) => {
      if (!published) {
        reject(error)
        return
      }
      console.warn('[automations] the agent launch failed after its terminal was published', error)
    })
  })
}

function requireWorkspaceId(automation: Automation): string {
  if (!automation.workspaceId) {
    throw new Error('The target workspace is no longer available.')
  }
  return automation.workspaceId
}
