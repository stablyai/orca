import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionOperations } from './host-session-operations'
import { nativeHostSessionBrowserOperations } from './native-host-session-browser-operations'
import { nativeHostSessionFileOperations } from './native-host-session-file-operations'
import { nativeHostSessionMarkdownOperations } from './native-host-session-markdown-operations'
import { nativeHostSessionNativeChatOperations } from './native-host-session-native-chat-operations'
import { nativeHostSessionQuickCommandOperations } from './native-host-session-quick-command-operations'
import { nativeHostSessionTabOperations } from './native-host-session-tab-operations'
import { nativeHostSessionTerminalFileOperations } from './native-host-session-terminal-file-operations'
import { nativeHostSessionTerminalOperations } from './native-host-session-terminal-operations'

export function nativeHostSessionOperations(client: RpcClient): HostSessionOperations {
  return {
    tab: nativeHostSessionTabOperations(client),
    terminal: nativeHostSessionTerminalOperations(client),
    terminalFile: nativeHostSessionTerminalFileOperations(client),
    file: nativeHostSessionFileOperations(client),
    markdown: nativeHostSessionMarkdownOperations(client),
    quickCommand: nativeHostSessionQuickCommandOperations(client),
    browser: nativeHostSessionBrowserOperations(client),
    nativeChat: nativeHostSessionNativeChatOperations(client)
  }
}
