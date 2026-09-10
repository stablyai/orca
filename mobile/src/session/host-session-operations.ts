import type { HostSessionBrowserOperations } from './host-session-browser-operations'
import type { HostSessionFileOperations } from './host-session-file-operations'
import type { HostSessionMarkdownOperations } from './host-session-markdown-operations'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import type { HostSessionQuickCommandOperations } from './host-session-quick-command-operations'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import type { HostSessionTerminalFileOperations } from './host-session-terminal-file-operations'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'

/** Everything the session screen asks a host for, grouped by concern so a screen takes one prop
 *  and a provider is built once. Each namespace keeps its own contract file. */
export type HostSessionOperations = {
  tab: HostSessionTabOperations
  terminal: HostSessionTerminalOperations
  terminalFile: HostSessionTerminalFileOperations
  file: HostSessionFileOperations
  markdown: HostSessionMarkdownOperations
  quickCommand: HostSessionQuickCommandOperations
  browser: HostSessionBrowserOperations
  nativeChat: HostSessionNativeChatOperations
}
