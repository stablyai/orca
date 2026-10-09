/**
 * A server-run automation's agent, started through the shared launch executor.
 *
 * Automations observe their run from the PTY, so the launch is `terminalOnly` whatever the chat
 * default says. What stays the automation's own is in the factories: a new-per-run workspace is
 * created agent-first from the automation's create args, and an existing workspace gets a terminal
 * titled with the run. Both fold an argv agent's prompt into its command at any length, as the
 * automation always has. A post-start agent's prompt goes out through the follow-up writer the create
 * always used, for parity: the executor's composer readiness misses slow starts (a follow-up fixes it).
 */

import type {
  AgentLaunchPublishedSurface,
  AgentLaunchSurfaceExecution
} from '../agent-launch/agent-launch-execution'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'

const TERMINAL_ONLY_MESSAGE = 'An automation starts a terminal agent only.'

type LaunchedTerminal = {
  handle: string
  tabId?: string | null
  paneKey?: string | null
  ptyId?: string | null
}

export type HeadlessAutomationAgentLaunch = Omit<HeadlessAutomationDispatchLaunch, 'completion'> & {
  terminalHandle: string
}

export async function launchHeadlessAutomationAgent(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
    target: Extract<AutomationRunTargetResult, { ok: true }>
  }
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const agent = automation.agentId
  // The startup plan trims the prompt for every agent; a blank one launches the agent bare.
  const text = automation.prompt?.trim()
  let workspace: { id: string; displayName: string | null } | undefined
  let terminal: LaunchedTerminal | undefined
  const execution: AgentLaunchSurfaceExecution = {
    runtime,
    intent: {
      agent,
      // The workspace factory builds the create from the automation, so the target carries none.
      target:
        automation.workspaceMode === 'new_per_run'
          ? { kind: 'create-worktree', create: {} }
          : { kind: 'existing', worktree: requireWorkspaceId(automation) },
      ...(text ? { prompt: { text, delivery: 'submit' as const } } : {})
    },
    terminalOnly: true,
    workspaces: {
      createWorktree: async ({ startupAgent, startupPrompt }) => {
        // Agent-first is the only create here; a structured pre-flight must not reach it.
        if (startupAgent === undefined) {
          throw new Error(TERMINAL_ONLY_MESSAGE)
        }
        const { startupPrompt: _prompt, ...create } = buildHeadlessAutomationWorktreeCreateArgs({
          automation,
          run,
          repo: target.repo
        })
        const created = await runtime.createManagedWorktree({
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
          ...(startup.paneKey ? { startupTerminalPaneKey: startup.paneKey } : {}),
          // The create folds an offered prompt at any length; staging carries long lines.
          ...(startupPrompt ? { promptRodeLaunchCommand: true } : {})
        }
      }
    },
    surfaces: {
      createStructuredSession: () => {
        throw new Error(TERMINAL_ONLY_MESSAGE)
      },
      createTerminalAgent: async ({ worktreeId, startupPrompt }) => {
        const launched = await runtime.launchAgentTerminal(`id:${worktreeId}`, {
          agent,
          prompt: startupPrompt ?? '',
          title: run.title,
          ...(automation.extraAgentArgs ? { extraAgentArgs: automation.extraAgentArgs } : {})
        })
        terminal = launched
        const shown = await runtime.showManagedWorktree(`id:${launched.worktreeId}`)
        workspace = { id: launched.worktreeId, displayName: shown.displayName ?? null }
        return {
          handle: launched.handle,
          ...(launched.paneKey ? { paneKey: launched.paneKey } : {}),
          ...(startupPrompt ? { promptRodeLaunchCommand: true } : {})
        }
      },
      // Only fresh launches reach here: an automation never reuses a terminal.
      deliverTerminalPrompt: ({ handle, prompt }) =>
        runtime.deliverStartupFollowup(handle, {
          expectedProcess: TUI_AGENT_CONFIG[agent].expectedProcess,
          prompt: prompt.text
        })
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

/**
 * Settles once the agent's terminal exists, as the run was always recorded; a post-start prompt
 * is still being delivered, and the run's watcher observes the agent from here on.
 */
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
