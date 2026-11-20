import { ipcMain } from 'electron'
import { NativeChatVerifyRanges } from '../../shared/rpc-contract/native-chat/native-chat-params'
import { openNativeChatTranscript } from '../native-chat/transcript-discovery/native-chat-open-wake'
import { verifySessionTranscriptRanges } from '../native-chat/transcript-watching/verify-session-transcript-ranges'
import { abortWhenRendererGone } from './renderer-requests/renderer-lifetime-abort'

export function registerNativeChatRangeVerification(): void {
  const pending = new Map<number, Map<string, AbortController>>()
  ipcMain.on('nativeChat:cancelVerifyRanges', (event, requestId: string) => {
    pending.get(event.sender.id)?.get(requestId)?.abort()
  })
  ipcMain.handle(
    'nativeChat:verifyTranscriptRanges',
    async (event, value: unknown, requestId: string) => {
      const args = NativeChatVerifyRanges.parse(value)
      const controller = new AbortController()
      const requests = pending.get(event.sender.id) ?? new Map<string, AbortController>()
      pending.set(event.sender.id, requests)
      requests.set(requestId, controller)
      const lifetime = abortWhenRendererGone(event.sender)
      try {
        const opened = openNativeChatTranscript(args.sessionId, args.transcriptPath, false)
        return await verifySessionTranscriptRanges(
          { ...args, transcriptPath: opened.transcriptPath },
          AbortSignal.any([controller.signal, lifetime.signal])
        )
      } finally {
        lifetime.dispose()
        requests.delete(requestId)
        if (requests.size === 0) {
          pending.delete(event.sender.id)
        }
      }
    }
  )
}
