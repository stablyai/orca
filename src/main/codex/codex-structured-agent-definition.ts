import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'

export const CODEX_STRUCTURED_AGENT: StructuredAgentDefinition = {
  agent: 'codex',
  capabilities: {
    // A thread with legacy, unpaginated history narrows this to unsupported once it runs.
    rewind: true,
    compact: true,
    // A goal change at rest starts the agent first.
    threadGoal: true,
    contextUsage: false,
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
