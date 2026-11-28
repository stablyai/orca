/** ZCode's chat declaration: `zcode -p --output-format stream-json` runs one foreground turn per
 *  prompt and `--resume <sess_...>` continues it, so this provider is a CLI chat, not a server. */

import type { DirectoryAccountAgentDefinition } from '../../native-chat/agent-session-wire/providers/structured-agent-definition'
import { ZCODE_STRUCTURED_HANDLE_NAMESPACE } from './zcode-provider-handle'

export const ZCODE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'zcode',
  handleTransport: ZCODE_STRUCTURED_HANDLE_NAMESPACE.transport,
  // ZCode's settings file names the config directory its CLI reads (~/.zcode by default).
  accountHomeVariable: 'ZCODE_CLI_SETTINGS_FILE',
  // A `--resume` turn continues the conversation the provider recorded, not a fresh transcript.
  instructionsEachStart: false,
  capabilities: {
    rewind: false,
    compact: false,
    threadGoal: false,
    contextUsage: false,
    imagePrompts: false,
    steering: 'queue',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) => key === 'model' || key === 'effort',
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}
