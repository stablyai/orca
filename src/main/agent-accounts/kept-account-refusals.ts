import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

// Why typed: a terminal shows the message through its spawn error, and nothing falls back.
function refusal(message: string): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(message))
}

export const keptAccountRefusals = {
  indexUnavailable: (filePath: string): AgentSessionPreSpawnError =>
    refusal(
      `Orca could not read which account this agent is kept on (${filePath}). Make sure Orca can read that file, or move it aside to start agents on the selected account.`
    ),
  laneMismatch: (): AgentSessionPreSpawnError =>
    refusal(
      'This agent is kept on an account from another environment (host or WSL). Open it there, or un-keep it from the tab menu.'
    ),
  accountRemoved: (): AgentSessionPreSpawnError =>
    refusal(
      'This agent is kept on an account that is no longer saved in Orca. Un-keep it from the tab menu to start it on the selected account.'
    ),
  codexHomeUntrusted: (label: string): AgentSessionPreSpawnError =>
    refusal(
      `This agent is kept on ${label}, but Orca could not verify that account's Codex folder. Sign in to it again in Settings, or un-keep the agent.`
    ),
  codexSystemDefaultWithCustomHome: (): AgentSessionPreSpawnError =>
    refusal(
      'This agent is kept on System default, which Orca cannot start while CODEX_HOME is set. Unset CODEX_HOME, or un-keep the agent.'
    ),
  codexConversationMissing: (label: string): AgentSessionPreSpawnError =>
    refusal(
      `This agent is kept on ${label}, but its conversation was not found. Un-keep it to start a new session.`
    )
}
