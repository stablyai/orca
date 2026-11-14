import type { DirectoryAccountAgentDefinition } from '../../../native-chat/agent-session-wire/providers/structured-agent-definition'
import { CODEX_STRUCTURED_HANDLE_NAMESPACE } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { isCodexTurnOptionKey } from '../turns/codex-turn-option-keys'

export const CODEX_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'codex',
  handleTransport: CODEX_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'CODEX_HOME',
  capabilities: {
    // A thread with legacy, unpaginated history narrows this to unsupported once it runs.
    rewind: true,
    fork: 'checkpoint',
    compact: true,
    review: true,
    cleanBackgroundTerminals: true,
    // A goal change at rest starts the agent first.
    threadGoal: true,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    // Approval and sandbox policy ride on the thread; the app-server enforces them.
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: isCodexTurnOptionKey,
    // No built-in list: the client fills the current model from its own unknown-model defaults.
    fallbackModels: () => null,
    // A running child answers only the effort its thread reported, never the model's default.
    effortDefaultsToModel: false
  }
}
