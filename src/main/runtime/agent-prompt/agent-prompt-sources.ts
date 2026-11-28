import {
  parseChatPromptId,
  parseTerminalPromptId
} from '../../../shared/agent-prompt/pending-agent-prompt'
import type { MobilePushPrompt } from '../../../shared/notifications/mobile-push-contract'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { applyChatPrompt, chatTargetExists, listChatPrompts } from './agent-prompt-chat'
import type { AgentPromptDirectory } from './agent-prompt-service'
import {
  applyTerminalPrompt,
  listTerminalPrompts,
  terminalPtyExists,
  type AgentPromptRuntime
} from './agent-prompt-terminal'
import type { LocatedAgentPrompt } from './located-agent-prompt'

export { agentPromptResultFromRefusal, chatPromptMutation } from './agent-prompt-chat'
export type { AgentPromptRuntime } from './agent-prompt-terminal'

export function listLocatedPrompts(runtime: AgentPromptRuntime): LocatedAgentPrompt[] {
  return [...listChatPrompts(getStructuredAgentSessionHost()), ...listTerminalPrompts(runtime)]
}

export function pushPromptForPane(
  runtime: AgentPromptRuntime,
  paneKey: string
): MobilePushPrompt | null {
  const matches = listLocatedPrompts(runtime).filter((item) => item.paneKey === paneKey)
  if (matches.length !== 1) {
    return null
  }
  const prompt = matches[0]?.prompt
  if (!prompt) {
    return null
  }
  return {
    promptId: prompt.promptId,
    options: prompt.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      role: option.role
    }))
  }
}

export function createAgentPromptDirectory(runtime: AgentPromptRuntime): AgentPromptDirectory {
  return {
    list: () => listLocatedPrompts(runtime).map((item) => item.prompt),
    targetExists: (promptId) => {
      const chat = parseChatPromptId(promptId)
      if (chat) {
        return chatTargetExists(chat.sessionId)
      }
      const terminal = parseTerminalPromptId(promptId)
      return terminal ? terminalPtyExists(runtime, terminal.ptyId) : false
    },
    apply: (prompt, optionId, clientOperationId, callerKey) =>
      prompt.target.type === 'chat'
        ? applyChatPrompt(prompt, optionId, clientOperationId, callerKey)
        : applyTerminalPrompt(runtime, prompt, optionId)
  }
}
