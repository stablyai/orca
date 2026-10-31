import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import { CLAUDE_STRUCTURED_HANDLE_NAMESPACE } from '../../shared/agent-session-provider-handle-encoding'
import { isClaudeStructuredOptionKey } from './claude-structured-options'
import { claudeFallbackModelOptions } from './claude-structured-session-options'

export const CLAUDE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'claude',
  handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'CLAUDE_CONFIG_DIR',
  capabilities: {
    rewind: true,
    compact: true,
    threadGoal: false,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: isClaudeStructuredOptionKey,
    fallbackModels: claudeFallbackModelOptions,
    effortDefaultsToModel: true
  }
}
