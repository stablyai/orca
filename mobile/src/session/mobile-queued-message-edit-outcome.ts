import type { AgentSessionQueuedMessageUpdateResult } from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import type { MobileQueuedEditDraft } from './mobile-queued-message-edit-draft'
import type { StructuredAgentSessionMutationResult } from './mobile-structured-agent-session-rpc'
import { readMobileNativeChatDraftInputs } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { mobileQueuedEditValueKey } from './mobile-queued-message-edit-value'

type Outcome = 'close' | 'rebase' | 'gone' | 'changed' | 'refused' | 'stay'
export function settleMobileQueuedEdit(
  edit: MobileQueuedEditDraft,
  attempt = edit.attempt,
  result?: StructuredAgentSessionMutationResult<AgentSessionQueuedMessageUpdateResult>
): Outcome {
  if (edit.closed || edit.attempt !== attempt) {
    return 'stay'
  }
  const loss =
    edit.leaseLoss?.lease === edit.lease && edit.leaseLoss.expected === edit.fingerprint
      ? edit.leaseLoss.status
      : undefined
  const lost = loss === 'changed' ? 'changed' : loss ? 'gone' : undefined
  const { messages, submissions } = edit.published
  const message = messages?.find((entry) => entry.messageId === edit.messageId)
  const available = edit.published.cards.some((entry) => entry.messageId === edit.messageId)
  const sent =
    attempt &&
    submissions.some(
      (entry) =>
        entry.queuedMessageId === edit.messageId && entry.payloadFingerprint === attempt.fingerprint
    )
  let proof = Boolean(
    attempt &&
    ((message &&
      agentSessionSendBodyFingerprint(edit.sessionId, message.body) === attempt.fingerprint) ||
      sent)
  )
  if (result?.status === 'accepted') {
    const status = result.value.status
    if (status === 'gone' || status === 'changed') {
      edit.attempt = undefined
      return status
    }
    if (status !== 'updated' && status !== 'unchanged') {
      edit.attempt = undefined
      return (
        lost ??
        (edit.pendingClose || (messages !== null && (!message || !available)) ? 'gone' : 'refused')
      )
    }
    proof = result.value.fingerprint === attempt?.fingerprint
    if (!proof && attempt) {
      attempt.phase = 'unknown'
      edit.uncertain ||= attempt.fingerprint !== attempt.expected
    }
  } else if (result?.status === 'rejected') {
    edit.attempt = undefined
    return (
      lost ??
      (edit.pendingClose || (messages !== null && (!message || !available)) ? 'gone' : 'refused')
    )
  } else if (result?.status === 'unknown' && attempt) {
    attempt.phase = 'unknown'
    edit.uncertain ||= attempt.fingerprint !== attempt.expected
  }
  if (attempt && proof) {
    if (edit.uncertain && attempt.fingerprint === edit.fingerprint) {
      attempt.phase = 'unknown'
      return lost ?? (edit.pendingClose || sent ? 'gone' : 'stay')
    }
    const equal =
      mobileQueuedEditValueKey(edit.text, readMobileNativeChatDraftInputs(edit.scopeKey)) ===
      attempt.key
    const blocks = attempt.body.blocks.filter((block) => block.type === 'image-ref')
    edit.kept = attempt.inputs.images.flatMap((image, index) =>
      blocks[index] ? [{ image, block: blocks[index] }] : []
    )
    edit.body = attempt.body
    edit.baseKey = attempt.key
    edit.fingerprint = attempt.fingerprint
    edit.uncertain = false
    edit.attempt = undefined
    if (equal) {
      return 'close'
    }
    return edit.pendingClose ||
      sent ||
      (messages !== null && (!message || !available)) ||
      loss === 'gone' ||
      loss === 'not-editable'
      ? 'gone'
      : loss === 'changed' && attempt.fingerprint === attempt.expected
        ? 'changed'
        : 'rebase'
  }
  if (lost) {
    return lost
  }
  if (edit.pendingClose || (messages !== null && (!message || !available))) {
    return 'gone'
  }
  if (
    !result &&
    message &&
    agentSessionSendBodyFingerprint(edit.sessionId, message.body) !== edit.fingerprint
  ) {
    return 'changed'
  }
  return 'stay'
}
