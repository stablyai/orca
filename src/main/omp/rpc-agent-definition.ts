import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

export const OMP_RPC_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'omp',
  handleTransport: 'jsonl-rpc',
  legacyHandleTransports: ['acp'],
  accountHomeVariable: 'PI_CODING_AGENT_DIR',
  capabilities: {
    rewind: true,
    compact: true,
    threadGoal: true,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) => key === 'model' || key === 'effort' || key === 'fastMode',
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
