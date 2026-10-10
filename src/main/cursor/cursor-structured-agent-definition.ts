import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

export const CURSOR_HANDLE_TRANSPORT = 'cursor-sdk'

const CURSOR_OPTION_KEYS: ReadonlySet<string> = new Set([
  'model',
  'effort',
  'fastMode',
  'conversationMode',
  'context',
  'thinking'
])

export function isCursorStructuredOptionKey(key: string): boolean {
  return CURSOR_OPTION_KEYS.has(key)
}

export const CURSOR_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'cursor',
  handleTransport: CURSOR_HANDLE_TRANSPORT,
  accountHomeVariable: 'CURSOR_SDK_HOME',
  capabilities: {
    rewind: false,
    compact: false,
    threadGoal: false,
    contextUsage: true,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: isCursorStructuredOptionKey,
    fallbackModels: () => [{ id: 'auto', label: 'Auto', isDefault: true, efforts: [] }],
    effortDefaultsToModel: true,
    awaitsFirstListing: true
  }
}
