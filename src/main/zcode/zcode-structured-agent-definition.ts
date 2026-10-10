import { ZCODE_STRUCTURED_HANDLE_NAMESPACE } from '../../shared/agent-session-provider-handle-encoding'
import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

/** The only session option a ZCode chat takes: which model its turns run on. */
const ZCODE_OPTION_KEYS: ReadonlySet<string> = new Set(['model'])

export function isZcodeStructuredOptionKey(key: string): boolean {
  return ZCODE_OPTION_KEYS.has(key)
}

/**
 * What the host knows about ZCode before any of its sessions runs. The protocol has no rewind,
 * compaction, goal, usage or image surface, so the chat hides all of those; Orca answers every
 * permission request the agent's reverse RPC asks.
 */
export const ZCODE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'zcode',
  handleTransport: ZCODE_STRUCTURED_HANDLE_NAMESPACE.transport,
  accountHomeVariable: 'ZCODE_HOME',
  capabilities: {
    rewind: false,
    compact: false,
    threadGoal: false,
    contextUsage: false,
    imagePrompts: false,
    steering: 'queue',
    approvalEnforcement: 'orca'
  },
  restingOptions: {
    acceptsKey: isZcodeStructuredOptionKey,
    // ZCode lists no models over the protocol; the client keeps its own unknown-model defaults.
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
