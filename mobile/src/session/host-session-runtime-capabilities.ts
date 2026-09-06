import { MOBILE_AI_VAULT_CAPABILITY } from '../agent-history/agent-history-capability'
import { supportsMobileQuickCommands } from '../terminal/quick-commands'
import { TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

export type HostSessionRuntimeCapabilities = {
  browserScreencastSupported: boolean
  agentHistorySupported: boolean
  quickCommandsSupported: boolean
  terminalQueryReplyInputSupported: boolean
}

export function projectHostSessionRuntimeCapabilities(
  capabilities: readonly string[]
): HostSessionRuntimeCapabilities {
  return {
    browserScreencastSupported: capabilities.includes('browser.screencast.v1'),
    agentHistorySupported: capabilities.includes(MOBILE_AI_VAULT_CAPABILITY),
    quickCommandsSupported: supportsMobileQuickCommands(capabilities),
    terminalQueryReplyInputSupported: capabilities.includes(
      TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY
    )
  }
}
