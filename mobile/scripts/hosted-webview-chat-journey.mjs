import { randomUUID } from 'node:crypto'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  setHostedWebViewInput,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { EMULATOR_AGENT_HISTORY_PREVIEW_MARKER } from './emulator-agent-history-fixture.mjs'
import {
  appendHostedChatFeedMarker,
  assertHostedChatInputReceipt
} from './hosted-chat-transcript-fixture.mjs'

// The caller binds the existing seeded transcript to its owned real PTY before opening Chat.
export async function verifyHostedChatJourney({
  discoveryUrl,
  timeoutMs,
  transcriptPath,
  receiptPath
}) {
  const waitText = (expectedText) =>
    waitForVisibleHostedWebView({
      discoveryUrl,
      timeoutMs,
      expectedHrefIncludes: '/session/',
      expectedText
    })
  const initial = await waitText(EMULATOR_AGENT_HISTORY_PREVIEW_MARKER)
  const initialState = await readHostedWebViewState(initial)
  if (!initialState.labels.includes('Send message')) {
    throw new Error('Chat composer is missing')
  }
  const marker = await appendHostedChatFeedMarker(transcriptPath)
  const streamed = await waitText(marker)
  if (initial.targetId !== streamed.targetId) {
    throw new Error('Chat feed required a document reload')
  }
  const message = `ORCA_CHAT_SEND_${randomUUID()}`
  await setHostedWebViewInput(streamed, {
    placeholder: 'Message, @files, /commands',
    value: message
  })
  await activateHostedWebViewControl(streamed, { kind: 'label', value: 'Send message' })
  const deadline = Date.now() + timeoutMs
  let receiptError
  while (Date.now() < deadline) {
    try {
      const receipt = await assertHostedChatInputReceipt(receiptPath, message)
      return {
        document: streamed,
        evidence: { transcriptRead: true, feedWithoutReload: true, ...receipt }
      }
    } catch (error) {
      receiptError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw receiptError ?? new Error('Chat send receipt timed out')
}
