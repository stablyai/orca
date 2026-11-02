import { argvLaunchPrompt } from './agent-launch-prompt-delivery'
import { acceptedTerminalIntent } from './agent-launch-acceptance'
import { terminalLaunchInputs } from './agent-launch-surface-factories'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'
import type { CreatedSurface } from './agent-launch-executor'

/** The terminal agent a launch starts, chosen or as the alternative to a refused chat. */
export async function createTerminalSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: { worktreeId: string; connectionId?: string | null }
): Promise<CreatedSurface> {
  const { surfaces } = execution
  const intent = acceptedTerminalIntent(execution.intent, execution.acceptance)
  const callerCommand = execution.acceptance?.terminalStartup
  // A caller's own command cannot take an argv prompt; its prompt is sent or left unsent after start.
  const startupPrompt = callerCommand ? undefined : argvLaunchPrompt(intent)
  const draft = intent.prompt?.delivery === 'draft' ? intent.prompt.text : undefined
  const terminal = await surfaces.createTerminalAgent({
    worktreeId: workspace.worktreeId,
    agent: intent.agent,
    ...(startupPrompt ? { startupPrompt } : {}),
    ...terminalLaunchInputs(intent),
    ...(callerCommand ? { startup: { ...callerCommand, ...(draft ? { draft } : {}) } } : {}),
    viewMode: 'terminal'
  })
  return {
    outcome: {
      kind: 'terminal',
      handle: terminal.handle,
      ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {})
    },
    terminalCreation: terminal.terminalCreation,
    ...(terminal.warning ? { warning: terminal.warning } : {}),
    ...(startupPrompt && terminal.promptRodeLaunchCommand ? { promptRodeLaunchCommand: true } : {})
  }
}
