import type { DirectoryAccountAgentDefinition } from '../../native-chat/agent-session-wire/providers/structured-agent-definition'
import { CLAUDE_STRUCTURED_HANDLE_NAMESPACE } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { isClaudeStructuredOptionKey } from './launch/claude-structured-options'
import { claudeFallbackModelOptions } from './launch/claude-structured-session-options'
import { managedAgentCli } from '../../managed-agent-cli/managed-agent-cli-registry'

export const CLAUDE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'claude',
  handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'CLAUDE_CONFIG_DIR',
  managedRuntime: () => managedAgentCli('claude').available(),
  capabilities: {
    rewind: true,
    fork: 'checkpoint',
    compact: true,
    compactInstructions: true,
    compactBesideBackgroundTasks: true,
    mcpServers: true,
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
