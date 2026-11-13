import type { DirectoryAccountAgentDefinition } from '../../../native-chat/agent-session-wire/providers/structured-agent-definition'

export const ZCODE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'zcode-app-server',
  agent: 'zcode'
} as const

export const ZCODE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'zcode',
  handleTransport: ZCODE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'ZCODE_HOME',
  capabilities: {
    // No rewind RPC: Orca rewinds by resuming the fork that keeps the earlier turns, which the
    // adapter performs over a disposable backend even when the chat has no live child.
    rewind: true,
    fork: 'checkpoint',
    compact: true,
    threadGoal: false,
    contextUsage: true,
    imagePrompts: false,
    // Mid-turn sends are accepted and queued by the backend itself (steer events report them).
    steering: 'queue',
    // The backend gates tools by session mode and asks through interaction requests.
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) => key === 'model' || key === 'effort' || key === 'interactionMode',
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
