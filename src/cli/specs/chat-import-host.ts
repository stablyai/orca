import type { CommandSpec } from '../args'

export const CHAT_IMPORT_HOST_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat-import-host'],
    // Why: launched by the browser over stdin/stdout as a native-messaging
    // host, not meant for interactive/manual invocation.
    summary: 'Run the browser native-messaging host for web chat import',
    usage: 'orca chat-import-host',
    allowedFlags: []
  }
]
