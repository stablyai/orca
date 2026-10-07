/** Creating the agent's surface — a structured session or a terminal — in a workspace that exists. */
import type { AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchIntent, AgentLaunchResult } from '../../shared/agent-launch-intent'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { argvLaunchPrompt } from './agent-launch-prompt-delivery'
import { deriveAgentLaunchTerminalViewMode } from './agent-launch-view-mode'
import { readAgentLaunchModeSettings, type AgentLaunchModeReceipt } from './agent-launch-mode'
import type { AgentLaunchStructuredSurface } from './agent-launch-surface-factories'

/** `structured` is the same surface `outcome` names, kept typed so prompt delivery reads the create's
 *  own fence rather than branching on `outcome.kind` and re-deriving it. */
export type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  structured?: AgentLaunchStructuredSurface
  /** True when this create folded the prompt into the agent's launch command. */
  promptRodeLaunchCommand?: boolean
}

export async function createSurface(
  execution: AgentLaunchExecution,
  workspace: { worktreeId: string; connectionId: string | null | undefined },
  settled: AgentLaunchModeReceipt
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured') {
    // One reservation serves either route: the tab half of the reserved pane is the chat's tab.
    const reservedTabId = intent.paneKey ? parsePaneKey(intent.paneKey)?.tabId : undefined
    const session = await surfaces.createStructuredSession({
      worktreeId: workspace.worktreeId,
      agent: intent.agent,
      ...(intent.sessionOptions ? { options: intent.sessionOptions } : {}),
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(reservedTabId ? { tabId: reservedTabId } : {})
    })
    return {
      outcome: {
        kind: 'structured',
        sessionId: session.sessionId,
        handle: session.handle,
        ...(session.tabId ? { tabId: session.tabId } : {})
      },
      structured: session,
      ...ignoredStructuredAgentArgsWarning(intent)
    }
  }
  return createTerminalSurface(execution, workspace)
}

/**
 * Structured chat uses saved Arguments, so a per-call override still needs a truthful warning.
 */
function ignoredStructuredAgentArgsWarning(
  intent: AgentLaunchIntent
): { warning: string } | undefined {
  return intent.agentArgs === undefined
    ? undefined
    : {
        warning:
          'Started a structured chat session using saved agent Arguments; the per-launch argument override was ignored.'
      }
}

/** What every route that builds a terminal agent passes on, so the startup terminal of a new
 *  workspace and the terminal of an existing one start the same agent. */
export function terminalLaunchInputs(intent: AgentLaunchIntent) {
  return {
    ...(intent.sessionOptions ? { options: intent.sessionOptions } : {}),
    // `null` is a value the caller meant, so this tests for absence rather than falsiness.
    ...(intent.agentArgs !== undefined ? { agentArgs: intent.agentArgs } : {}),
    ...(intent.cwd ? { cwd: intent.cwd } : {}),
    ...(intent.launchSource ? { launchSource: intent.launchSource } : {}),
    ...(intent.paneKey ? { paneKey: intent.paneKey } : {})
  }
}

/**
 * The one place a terminal agent is created, so the structured-refusal downgrade builds the same
 * surface — carrying the same argv prompt — as a launch that chose a terminal outright.
 */
export async function createTerminalSurface(
  execution: AgentLaunchExecution,
  workspace: { worktreeId: string; connectionId: string | null | undefined }
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  const startupPrompt = argvLaunchPrompt(intent)
  const terminal = await surfaces.createTerminalAgent({
    worktreeId: workspace.worktreeId,
    agent: intent.agent,
    ...(startupPrompt ? { startupPrompt } : {}),
    ...terminalLaunchInputs(intent),
    viewMode: deriveAgentLaunchTerminalViewMode({
      settings: readAgentLaunchModeSettings(execution.runtime),
      agent: intent.agent,
      ...(intent.prompt ? { prompt: intent.prompt } : {}),
      connectionId: workspace.connectionId
    })
  })
  return {
    outcome: {
      kind: 'terminal',
      handle: terminal.handle,
      ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {})
    },
    ...(terminal.warning ? { warning: terminal.warning } : {}),
    ...(startupPrompt && terminal.promptRodeLaunchCommand ? { promptRodeLaunchCommand: true } : {})
  }
}
