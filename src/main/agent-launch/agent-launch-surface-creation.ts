import { parsePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionSendBody } from '../../shared/structured-agent-session-send-mutation'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'
import { ignoredStructuredLaunchInputsWarning } from './agent-launch-warnings'
import { argvLaunchPrompt } from './agent-launch-prompt-delivery'
import {
  terminalLaunchInputs,
  type AgentLaunchStructuredSurface,
  type AgentLaunchWorkspace
} from './agent-launch-surface-factories'

/** `structured` is the same surface `outcome` names, kept typed so prompt delivery reads the create's
 *  own fence rather than branching on `outcome.kind` and re-deriving it. */
export type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  structured?: AgentLaunchStructuredSurface
  /** True when this create folded the prompt into the agent's launch command. */
  promptRodeLaunchCommand?: boolean
}

export async function createLaunchSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: Pick<AgentLaunchWorkspace, 'worktreeId' | 'connectionId' | 'sequenceTerminalCommand'>,
  settled: AgentLaunchModeReceipt
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured') {
    // One reservation serves either route: the tab half of the reserved pane is the chat's tab.
    const reservedTabId = intent.paneKey ? parsePaneKey(intent.paneKey)?.tabId : undefined
    const session = await surfaces.createStructuredSession({
      worktreeId: workspace.worktreeId,
      ...(execution.hostFoundingAttempt
        ? { hostFoundingAttempt: execution.hostFoundingAttempt }
        : {}),
      agent: intent.agent,
      ...(intent.sessionOptions ? { options: intent.sessionOptions } : {}),
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(reservedTabId ? { tabId: reservedTabId } : {}),
      ...(intent.prompt?.delivery === 'submit' && intent.prompt.text.trim()
        ? { firstMessage: structuredAgentSessionSendBody(intent.prompt.text, []) }
        : {})
    })
    return {
      outcome: {
        kind: 'structured',
        sessionId: session.sessionId,
        handle: session.handle,
        ...(session.tabId ? { tabId: session.tabId } : {})
      },
      structured: session,
      ...ignoredStructuredLaunchInputsWarning(intent)
    }
  }
  return createLaunchTerminalSurface(execution, workspace)
}

/**
 * The one place a terminal agent is created, so the structured-refusal downgrade builds the same
 * surface — carrying the same argv prompt — as a launch that chose a terminal outright.
 */
export async function createLaunchTerminalSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: Pick<AgentLaunchWorkspace, 'worktreeId' | 'connectionId' | 'sequenceTerminalCommand'>
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  const startupPrompt = argvLaunchPrompt(intent)
  const terminal = await surfaces.createTerminalAgent({
    worktreeId: workspace.worktreeId,
    agent: intent.agent,
    ...(workspace.sequenceTerminalCommand
      ? { sequenceTerminalCommand: workspace.sequenceTerminalCommand }
      : {}),
    ...(startupPrompt ? { startupPrompt } : {}),
    ...terminalLaunchInputs(intent),
    viewMode: 'terminal'
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
