import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { workspaceKindForLaunchTarget } from '../../shared/workspace-launch-kind'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings,
  DEFAULT_LAUNCH_VOCABULARY,
  type AgentLaunchModeReceipt,
  type AgentLaunchModeVocabulary
} from './agent-launch-mode'

/** The same preflight is used for admission and execution, before workspace creation. */
export function decideAgentLaunchIntentMode(execution: {
  intent: AgentLaunchIntent
  runtime: Parameters<typeof readAgentLaunchModeSettings>[0]
  terminalOnly?: boolean
  callerRendersStructured?: boolean
  vocabulary?: AgentLaunchModeVocabulary
}): AgentLaunchModeReceipt {
  const { intent, runtime } = execution
  return decideAgentLaunchMode({
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
    settings: execution.terminalOnly
      ? undefined
      : readAgentLaunchModeSettings(runtime, intent.nativeChatDefault),
    ...(execution.terminalOnly ? { terminalOnly: true } : {}),
    ...(intent.surface ? { surface: intent.surface } : {}),
    vocabulary: execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  })
}
