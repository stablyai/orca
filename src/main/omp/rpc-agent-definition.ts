import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/providers/structured-agent-definition'
import { managedAgentCli } from '../managed-agent-cli/managed-agent-cli-registry'

export const OMP_RPC_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'omp',
  handleTransport: 'jsonl-rpc',
  accountHomeVariable: 'PI_CODING_AGENT_DIR',
  // Every launch passes --append-system-prompt, and OMP builds its system prompt from it at each start.
  instructionsEachStart: true,
  managedRuntime: () => managedAgentCli('omp').available(),
  capabilities: {
    rewind: false,
    compact: true,
    compactInstructions: true,
    threadGoal: false,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) => key === 'model' || key === 'effort',
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
