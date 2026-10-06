import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import { CLAUDE_STRUCTURED_HANDLE_NAMESPACE } from '../../shared/agent-session-provider-handle-encoding'
import { isClaudeStructuredOptionKey } from './claude-structured-options'
import { claudeFallbackModelOptions } from './claude-structured-session-options'

export const CLAUDE_STRUCTURED_AGENT: StructuredAgentDefinition = {
  agent: 'claude',
  handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'CLAUDE_CONFIG_DIR',
  capabilities: {
    // Orca's marker-based rewind proof can never pass on the real binary; rewind returns via a fork.
    rewind: false,
    compact: true,
    threadGoal: false,
    // A session at rest still reports the usage its journal recorded.
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    // The permission mode is a launch flag the CLI enforces.
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: isClaudeStructuredOptionKey,
    fallbackModels: claudeFallbackModelOptions,
    effortDefaultsToModel: true
  }
}
