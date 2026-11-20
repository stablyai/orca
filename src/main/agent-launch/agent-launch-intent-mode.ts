import type {
  AgentLaunchIntent,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch/contracts/agent-launch-intent'
import { agentCopyIdFromOptions } from '../../shared/agent-launch/catalog/agent-copies'
import { workspaceKindForLaunchTarget } from '../../shared/agent-launch/contracts/workspace-launch-kind'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings,
  DEFAULT_LAUNCH_VOCABULARY,
  type AgentLaunchModeVocabulary
} from './agent-launch-mode'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'

/** The same preflight is used for admission and execution, before workspace creation. */
export function decideAgentLaunchIntentMode(execution: {
  intent: AgentLaunchIntent
  runtime: Parameters<typeof readAgentLaunchModeSettings>[0]
  terminalOnly?: boolean
  callerRendersStructured?: boolean
  vocabulary?: AgentLaunchModeVocabulary
}): AgentLaunchModeReceipt {
  const { intent, runtime } = execution
  const vocabulary = execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  // A copy's command and environment reach terminals only, so its chat would run the base agent.
  const copy = agentCopyIdFromOptions(intent.sessionOptions ?? intent.chatOptions)
  if (copy && intent.surface === 'chat') {
    throw new AgentLaunchSurfaceUnavailableError(
      `${copy} can't open as a chat because agent copies open only in terminals. Start it in a terminal instead.`,
      'agent_copy'
    )
  }
  const receipt = decideAgentLaunchMode({
    placement: {
      agent: intent.agent,
      workspaceKind: workspaceKindForLaunchTarget(intent.target),
      ...(intent.reuseTerminal ? { terminal: intent.reuseTerminal.handle } : {}),
      ...(intent.cwd ? { cwd: intent.cwd } : {}),
      ...(intent.target.kind === 'existing' && intent.target.workspacePath
        ? { workspacePath: intent.target.workspacePath }
        : {}),
      ...(execution.callerRendersStructured === false ? { callerRendersStructured: false } : {})
    },
    settings:
      execution.terminalOnly || copy ? undefined : readAgentLaunchModeSettings(runtime, intent),
    ...(execution.terminalOnly || copy ? { terminalOnly: true } : {}),
    ...(intent.surface ? { surface: intent.surface } : {}),
    vocabulary
  })
  return copy && !execution.terminalOnly
    ? {
        mode: 'terminal',
        preferred: 'terminal',
        reason: 'agent_copy',
        detail: `Started ${vocabulary.terminal}; agent copies open only in terminals.`
      }
    : receipt
}
