import { ipcMain } from 'electron'
import { openNativeChatTranscript } from '../native-chat/transcript-discovery/native-chat-open-wake'
import { nativeChatTranscriptFind } from '../native-chat/transcript-find/native-chat-transcript-find'
import type {
  NativeChatFindArgs,
  NativeChatFindOutcome
} from '../../shared/native-chat/find/native-chat-session-find'

// One search per chat per window: a newer query or step replaces the scan still running.
const runningFinds = new Map<string, AbortController>()

async function findInNativeChatForSender(
  senderId: number,
  args: NativeChatFindArgs
): Promise<NativeChatFindOutcome> {
  const key = `${senderId}\0${args.sessionId}`
  runningFinds.get(key)?.abort()
  const controller = new AbortController()
  runningFinds.set(key, controller)
  try {
    const { transcriptPath } = openNativeChatTranscript(args.sessionId, args.transcriptPath, false)
    return await nativeChatTranscriptFind().find({ ...args, transcriptPath }, controller.signal)
  } catch (error) {
    return {
      error: controller.signal.aborted
        ? 'superseded'
        : error instanceof Error
          ? error.message
          : String(error)
    }
  } finally {
    if (runningFinds.get(key) === controller) {
      runningFinds.delete(key)
    }
  }
}

export function registerNativeChatFindHandler(): void {
  ipcMain.handle('nativeChat:find', (event, args: NativeChatFindArgs) =>
    findInNativeChatForSender(event.sender.id, args)
  )
}
