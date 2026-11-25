import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/providers/structured-agent-definition'

export const TRAEX_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'trae',
  handleTransport: 'traex-app-server',
  accountHomeVariable: 'TRAECLI_HOME',
  instructionsEachStart: false,
  capabilities: {
    rewind: true,
    fork: 'checkpoint',
    compact: true,
    compactInstructions: true,
    recap: true,
    threadGoal: true,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) =>
      key === 'model' || key === 'effort' || key === 'interactionMode' || key === 'contextMode',
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
