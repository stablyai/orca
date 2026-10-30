import { ipcMain, type WebContents } from 'electron'
import {
  readNativeChatCurrentRequests,
  cancelNativeChatCurrentQuestions
} from '../native-chat/native-chat-current-requests'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { NativeChatCancelCurrentQuestions as CancelParams } from '../../shared/rpc-contract/native-chat-params'
import type { NativeChatCurrentRequestsRead } from '../../shared/agent-session-current-requests-wire'
import { openNativeChatTranscript } from '../native-chat/native-chat-open-wake'

export function registerNativeChatCurrentRequestHandlers(
  ensureQuestions: () => Promise<void>,
  registerSenderCleanup: (sender: WebContents) => AbortSignal
): void {
  ipcMain.handle(
    'nativeChat:currentRequests',
    async (event, request: NativeChatCurrentRequestsRead) => {
      const signal = registerSenderCleanup(event.sender)
      const ownedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      await waitForPromiseWithSignal(ensureQuestions(), ownedSignal)
      const opened = openNativeChatTranscript(request.sessionId, request.transcriptPath)
      if (opened.waking) {
        await waitForPromiseWithSignal(opened.waking, ownedSignal)
      }
      ownedSignal.throwIfAborted()
      return readNativeChatCurrentRequests(
        { ...request, transcriptPath: opened.transcriptPath },
        ownedSignal
      )
    }
  )
  ipcMain.handle('nativeChat:cancelCurrentQuestions', async (event, input: unknown) => {
    const request = CancelParams.parse(input)
    const signal = registerSenderCleanup(event.sender)
    const ownedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    await waitForPromiseWithSignal(ensureQuestions(), ownedSignal)
    const opened = openNativeChatTranscript(request.sessionId, request.transcriptPath)
    if (opened.waking) {
      await waitForPromiseWithSignal(opened.waking, ownedSignal)
    }
    ownedSignal.throwIfAborted()
    await cancelNativeChatCurrentQuestions(
      { ...request, transcriptPath: opened.transcriptPath },
      'trusted-local:desktop',
      ownedSignal
    )
    return { cancelled: true }
  })
}
