import { chatImportDbPath } from '../../main/chat-import/chat-import-paths'
import { runChatImportHost } from '../chat-import-host/run-chat-import-host'
import type { CommandHandler } from '../dispatch'

export const CHAT_IMPORT_HOST_HANDLERS: Record<string, CommandHandler> = {
  // Why: stdout is the native-messaging channel to the browser, so this
  // handler must never share it with ordinary CLI logging/JSON output.
  'chat-import-host': async () => {
    await runChatImportHost({
      input: process.stdin,
      output: process.stdout,
      dbPath: chatImportDbPath()
    })
  }
}
