// Automations observe PTYs, so launch terminal agents regardless of the chat default.

import type { AgentLaunchSurfaceExecution } from '../agent-launch/agent-launch-execution'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { findReusableAutomationRun } from '../../shared/automation-session-reuse'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { deliverTerminalAgentLaunchPrompt } from '../runtime/rpc/methods/agent-launch-terminal-prompt'
import {
  AutomationRunLaunchError,
  type HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
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
    run: Pick<AutomationRun, 'id' | 'title' | 'scheduledFor' | 'trigger'>
    target: Extract<AutomationRunTargetResult, { ok: true }>
    runs: readonly AutomationRun[]
    agentPrompt: string
    bindSession: (target: HeadlessAutomationDispatchLaunch) => void
  }
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const agent = automation.agentId
  // An empty saved prompt still launches the agent without a turn.
  const text = request.agentPrompt.trim() || undefined
  if (automation.reuseSession && automation.workspaceMode === 'existing' && text) {
    const reused = await sendToReusableSession(runtime, { ...request, text })
    if (reused) {
      return reused
    }
  }
  let workspace: { id: string; displayName: string | null } | undefined
  let terminal: LaunchedTerminal | undefined
  const launchedTarget = (): HeadlessAutomationAgentLaunch => {
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
    onSurfacePublished: () => request.bindSession(launchedTarget()),
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
        const launched = await runtime.launchAgentTerminal(`id:${worktreeId}`, {
          agent,
          prompt: startupPrompt ?? '',
          title: run.title,
          suppressStartupUpdatePrompt: true,
          ...(automation.extraAgentArgs ? { extraAgentArgs: automation.extraAgentArgs } : {}),
          // Run now is the user's act and may start a stopped WSL distro; a scheduled run never does.
          ...(run.trigger === 'scheduled' ? {} : { wslUserAct: true as const })
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
      deliverTerminalPrompt: ({ handle, prompt }) =>
        runtime.deliverStartupFollowup(handle, { agent, prompt: prompt.text })
    }
  }
  try {
    const result = await executeAgentLaunch(execution)
    if (text && result.prompt?.outcome !== 'handed-to-terminal') {
      throw new Error('The automation agent did not accept its prompt.')
    }
    return launchedTarget()
  } catch (error) {
    if (workspace && terminal) {
      throw new AutomationRunLaunchError(
        error instanceof Error ? error.message : String(error),
        launchedTarget()
      )
    }
    throw error
  }
}

async function sendToReusableSession(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id'>
    runs: readonly AutomationRun[]
    text: string
    bindSession: (target: HeadlessAutomationDispatchLaunch) => void
  }
): Promise<HeadlessAutomationAgentLaunch | null> {
  const { automation, text } = request
  const worktreeId = requireWorkspaceId(automation)
  const session = findReusableAutomationRun({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId,
    currentRunId: request.run.id,
    runs: request.runs,
    agentStatusForPane: (paneKey) =>
      runtime
        .getAgentStatusRowsForPane(paneKey)
        .filter((row) => !row.providerSessionOnly)
        .toSorted((left, right) => right.receivedAt - left.receivedAt)[0],
    liveSession: (previous) => {
      const handle = runOwnHandle(runtime, previous)
      return handle ? { handle, previous } : null
    }
  })
  if (!session) {
    return null
  }
  const shown = await runtime.showManagedWorktree(`id:${worktreeId}`)
  const target = {
    workspaceId: worktreeId,
    workspaceDisplayName: shown.displayName ?? null,
    terminalHandle: session.handle,
    terminalSessionId: session.previous.terminalSessionId,
    terminalPaneKey: session.previous.terminalPaneKey,
    terminalPtyId: session.previous.terminalPtyId
  }
  request.bindSession(target)
  if (
    !(await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle: session.handle,
      agent: automation.agentId,
      freshLaunch: false,
      text,
      // Windows cannot prove which agent is foreground; refuse only a proven shell.
      unprovableHost: 'write-unless-shell'
    }))
  ) {
    return null
  }
  return target
}

/** Reject reused pane handles whose PTY no longer belongs to this run. */
export function runOwnHandle(
  runtime: Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey' | 'getTerminalPtyIdForHandle'>,
  run: AutomationRun
): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}

function requireWorkspaceId(automation: Automation): string {
  if (!automation.workspaceId) {
    throw new Error('The target workspace is no longer available.')
  }
  return automation.workspaceId
}
