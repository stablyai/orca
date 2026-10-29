import type { QueuedEditLeaseLoss } from '../../../src/shared/queued-message-edit-lease'
import {
  queuedMessageEditableText,
  queuedEditKeptImages
} from '../../../src/shared/queued-message-edit'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { createUuidV4 } from '../../../src/shared/uuid-v4'
import { startMobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import { mobileQueuedEditValueKey } from './mobile-queued-message-edit-value'
import { readMobileNativeChatDraftInputs } from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  seedMobileQueuedEditInputs,
  type MobileQueuedEditDraft as Edit,
  type MobileStructuredQueuedEditArgs
} from './mobile-queued-message-edit-draft'

export function createMobileQueuedEdit(
  args: MobileStructuredQueuedEditArgs,
  messageId: string,
  getClient: () => MobileStructuredQueuedEditArgs['client'],
  onLost: (edit: Edit, loss: QueuedEditLeaseLoss) => void
): Edit | null {
  const { enabled, client, sessionId, sessionKey } = args
  if (!enabled || !client || !sessionId) {
    return null
  }
  const message = args.messages?.find((entry) => entry.messageId === messageId)
  const text = message ? queuedMessageEditableText(message.body) : null
  if (!message || text === null) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
  const scopeKey = `queued-edit:${createUuidV4()}`
  seedMobileQueuedEditInputs(scopeKey, message.body)
  const edit: Edit = {
    scope: sessionKey,
    client,
    sessionId,
    published: {
      messages: args.messages,
      submissions: args.submissions ?? [],
      cards: args.cards
    },
    scopeKey,
    destination: args.composerScopeKey ?? null,
    handBackText: args.appendComposerText,
    messageId,
    body: message.body,
    text,
    fingerprint,
    uncertain: false,
    baseKey: mobileQueuedEditValueKey(text, readMobileNativeChatDraftInputs(scopeKey)),
    kept: queuedEditKeptImages(message.body).map((entry, index) => ({
      block: entry.block,
      image: readMobileNativeChatDraftInputs(scopeKey).images[index]
    })),
    closed: false,
    pendingClose: false,
    lease: startMobileQueuedEditLease({
      getClient,
      sessionId,
      messageId,
      expectedBodyFingerprint: fingerprint,
      onLost: (loss) => onLost(edit, loss)
    })
  }
  return edit
}
