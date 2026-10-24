/**
 * A server-run automation's agent, started through the shared launch executor: a structured chat
 * when the Chat UI default allows one here, else the terminal agent it always started.
 */

import type {
  AgentLaunchPublishedSurface,
  AgentLaunchSurfaceExecution
} from '../agent-launch/agent-launch-execution'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../shared/structured-agent-session-projection'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { commitStructuredAgentSessionLaunchPrompt } from '../runtime/rpc/methods/agent-launch-structured-prompt'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import {
  createHeadlessAutomationStructuredSession,
  runOwnHandle,
  sendToReusableHeadlessAutomationSession,
  supportsStructuredAutomationRuntime,
  waitForStructuredAutomationSetup
} from './headless-automation-session-reuse'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { structuredAutomationRunHandle } from './runtime-structured-run-observer'

export { runOwnHandle }

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
    runs: readonly AutomationRun[]
  }
): Promise<HeadlessAutomationAgentLaunch> {
  const { automation, run, target } = request
  const agent = automation.agentId
  const text = automation.prompt?.trim()
  if (
    automation.reuseSession &&
    !hasExtraAgentArgs(automation.extraAgentArgs) &&
    automation.workspaceMode === 'existing' &&
    text
  ) {
    const reused = await sendToReusableHeadlessAutomationSession(runtime, {
      ...request,
      text,
      worktreeId: requireWorkspaceId(automation)
    })
    if (reused) {
      return reused
    }
  }
  const terminalOnly =
    hasExtraAgentArgs(automation.extraAgentArgs) || !supportsStructuredAutomationRuntime(runtime)
  const caller = { callerKey: `automation:${run.id}` }
  let workspace: { id: string; displayName: string | null } | undefined
  let terminal: LaunchedTerminal | undefined
  let structured: { sessionId: string; tabId: string } | undefined
  const execution: AgentLaunchSurfaceExecution = {
    runtime,
    intent: {
      agent,
      target:
        automation.workspaceMode === 'new_per_run'
          ? { kind: 'create-worktree', create: {} }
          : { kind: 'existing', worktree: requireWorkspaceId(automation) },
      ...(text ? { prompt: { text, delivery: 'submit' as const } } : {})
    },
    ...(terminalOnly ? { terminalOnly: true } : {}),
    workspaces: {
      createRecoveryShell: async (worktreeId) => {
        await runtime.createTerminal?.(`id:${worktreeId}`, { surfaceOwner: false })
      },
      createWorktree: async ({
        startupAgent,
        startupPrompt,
        promisedAgentChat,
        onWorkspaceCreated
      }) => {
        const {
          startupAgent: _a,
          startupPrompt: _p,
          startupExtraAgentArgs: _e,
          ...create
        } = buildHeadlessAutomationWorktreeCreateArgs({ automation, run, repo: target.repo })
        const created = await runtime.createManagedWorktree({
          ...create,
          ...(startupAgent
            ? {
                startupAgent,
                ...(startupPrompt ? { startupPrompt } : {}),
                ...(automation.extraAgentArgs
                  ? { startupExtraAgentArgs: automation.extraAgentArgs }
                  : {})
              }
            : {
                ...(promisedAgentChat ? { promisedAgentChat: true } : {}),
                ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
                awaitTerminalProvisioning: true,
                observeSetupCompletion: true
              })
        })
        workspace = { id: created.worktree.id, displayName: created.worktree.displayName ?? null }
        if (!startupAgent) {
          await waitForStructuredAutomationSetup(runtime, created.setupReceipt)
          return {
            worktreeId: created.worktree.id,
            workspacePath: created.worktree.path,
            connectionId: getRepoRoutingConnectionId(target.repo),
            startupTerminalHandle: undefined
          }
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
          ...(startupPrompt ? { promptRodeLaunchCommand: true } : {})
        }
      }
    },
    surfaces: {
      createStructuredSession: async ({ worktreeId, agent: structuredAgent, withoutPrompt }) => {
        const created = await createHeadlessAutomationStructuredSession({
          runtime,
          caller,
          worktreeId,
          agent: structuredAgent,
          ...(withoutPrompt ? { withoutPrompt: true as const } : {})
        })
        structured = { sessionId: created.sessionId, tabId: created.tabId }
        if (!workspace) {
          const shown = await runtime.showManagedWorktree(`id:${worktreeId}`)
          workspace = { id: worktreeId, displayName: shown.displayName ?? null }
        }
        return created
      },
      deliverStructuredPrompt: ({ sessionId, fence, prompt }) =>
        commitStructuredAgentSessionLaunchPrompt({
          host: getStructuredAgentSessionHost(),
          caller,
          sessionId,
          fence,
          text: prompt.text
        }),
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
      deliverTerminalPrompt: ({ handle, prompt }) =>
        runtime.deliverStartupFollowup(handle, {
          expectedProcess: TUI_AGENT_CONFIG[agent].expectedProcess,
          prompt: prompt.text
        })
    }
  }
  const published = await launchUntilPublished(execution)
  if (published.outcome.kind === 'structured' && workspace && structured) {
    return {
      workspaceId: workspace.id,
      workspaceDisplayName: workspace.displayName,
      sessionKind: 'structured',
      chatSessionId: structured.sessionId,
      terminalHandle: structuredAutomationRunHandle(structured.sessionId),
      terminalSessionId: structured.tabId,
      terminalPaneKey: structuredAgentSessionPaneKey(structured.tabId, structured.sessionId),
      terminalPtyId: null
    }
  }
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
