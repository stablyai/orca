import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../terminal-reply-schema'
import { terminalQuickCommandsSchema } from './mobile-quick-command-reply-schema'
import '../../session/agent-launch/mobile-agent-detection-reply-schema'
import '../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../session/mobile-session-terminal-reply-schema'
import '../../worktree/session-worktree-record-reply-schema'
import '../../session/native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../../files/workspace-file-paths-reply-schema'

export const quickCommandsReader = rpcResultVariant(
  'terminal-quick-commands',
  terminalQuickCommandsSchema
)

// Load/save share the canonical parser; malformed lists remain null so they cannot erase host commands as an empty list.
export const quickCommandsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-read',
    method: 'settings.getTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)

import '../../session/tabs/mobile-session-tab-write-reply-schema'

export const quickCommandsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-write',
    method: 'settings.updateTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)
