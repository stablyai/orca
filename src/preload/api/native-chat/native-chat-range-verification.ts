import { ipcRenderer } from 'electron'
import type { NativeChatApi } from './native-chat-api'

export const verifyTranscriptRanges: NativeChatApi['verifyTranscriptRanges'] = (
  agent,
  sessionId,
  ranges,
  transcriptPath,
  requestId
) =>
  ipcRenderer.invoke(
    'nativeChat:verifyTranscriptRanges',
    { agent, sessionId, ranges, transcriptPath },
    requestId
  )

export function cancelTranscriptRangeVerification(requestId: string): void {
  ipcRenderer.send('nativeChat:cancelVerifyRanges', requestId)
}
