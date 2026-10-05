import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import {
  structuredAgentSessionDomainFingerprint,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import {
  bypassedMobileStructuredSendOperationId,
  clearMobileStructuredSendOperation,
  forgetBypassedMobileStructuredSendOperation,
  getOrCreateMobileStructuredSendOperation,
  mobileStructuredSendOperationKey,
  rememberBypassedMobileStructuredSendOperation
} from './mobile-structured-send-operation-journal'

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  callerIdentity: string
  expectedRuntimeFence: number
  text: string
  attachments: readonly (StructuredAgentSessionAttachment & { contentFingerprint?: string })[]
  /** Sent only when the host advertises `agent-session.queued-messages.v1`. */
  delivery?: 'queue-if-active'
  deadline?: number
  onError: (message: string) => void
  /** Told the journal submission an accepted send became, which says where it stands from now. */
  onAccepted?: (clientMessageId: string) => void
  /** Internal: the one fresh-id resend after a withdrawn replay. */
  resendingAfterWithdrawal?: true
  /** Internal: that resend when the withdrawn id's record could not be cleared. It bypasses the
   *  record, so failing storage never blocks the send; its id is kept in memory for this app run,
   *  so a retry after a lost answer replays it rather than sending again. */
  bypassRetainedRecord?: true
  /** Internal: on that resend, the key the withdrawn record matched. The remembered id is keyed
   *  by it, so a capability change since the lost answer never mints another id. */
  resendOperationKey?: string
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const requestedBody = structuredAgentSessionSendBody(input.text, input.attachments)
  const requestedPayloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body: requestedBody }
  })
  const intentFields = {
    text: input.text.trimEnd(),
    attachments: input.attachments.map(
      (attachment) =>
        attachment.contentFingerprint ??
        structuredAgentSessionDomainFingerprint({
          domain: 'mobile.nativeChat.image.preview',
          sessionId: '',
          fields: { previewUri: attachment.previewUri }
        })
    )
  }
  // `delivery` is part of the intent key, never a stored journal field: the
  // immediate key is exactly today's, so an older build still reads the journal.
  const operationKeyFor = (delivery: 'queue-if-active' | undefined): string =>
    mobileStructuredSendOperationKey({
      sessionKey: input.sessionKey,
      intentFingerprint: structuredAgentSessionDomainFingerprint({
        domain: 'mobile.agentSession.send.intent',
        sessionId: input.sessionKey,
        fields: delivery ? { ...intentFields, delivery } : intentFields
      })
    })
  const queuedOperationKey = operationKeyFor('queue-if-active')
  const immediateOperationKey = operationKeyFor(undefined)
  const requestedOperationKey = input.delivery ? queuedOperationKey : immediateOperationKey
  const attachmentPaths = input.attachments.map((attachment) => attachment.path)
  const resendKey = input.resendOperationKey ?? requestedOperationKey
  let operation: Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>
  try {
    if (input.bypassRetainedRecord) {
      operation = bypassOperation(resendKey, requestedPayloadFingerprint, attachmentPaths)
    } else if (
      input.resendOperationKey !== undefined &&
      bypassedMobileStructuredSendOperationId(resendKey) !== undefined
    ) {
      // Storage recovered after a bypassed resend's answer was lost: that id is replayed, never
      // replaced by a fresh one that could deliver the message twice.
      operation = await adoptBypassedOperation({
        operationKey: resendKey,
        callerIdentity: input.callerIdentity,
        payloadFingerprint: requestedPayloadFingerprint,
        attachmentPaths
      })
    } else {
      operation = await getOrCreateMobileStructuredSendOperation({
        operationKey: requestedOperationKey,
        // A retained id replays exactly as first sent, whatever the capability says now;
        // a host that refuses that request shape retires it, so the next send goes out fresh.
        alternateOperationKey: input.delivery ? immediateOperationKey : queuedOperationKey,
        callerIdentity: input.callerIdentity,
        payloadFingerprint: requestedPayloadFingerprint,
        attachmentPaths,
        createOperationId: structuredSessionOperationId
      })
    }
  } catch {
    input.onError('Message not sent')
    return 'rejected'
  }
  const operationKey = operation.operationKey
  const delivery = operationKey === queuedOperationKey ? 'queue-if-active' : undefined
  const body = structuredAgentSessionSendBody(
    input.text,
    operation.attachmentPaths.map((path) => ({ path, previewUri: '' }))
  )
  const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body }
  })
  if (payloadFingerprint !== operation.payloadFingerprint) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    // `delivery` joins the wire fields — and so the operation fingerprint — but
    // never the journal's body-only fingerprint the submission echo recomputes.
    fields: { body, ...(delivery ? { delivery } : {}) },
    clientOperationId: operation.operationId,
    timeoutMs
  })
  const outcome = mobileStructuredSendDelivery(result, operation.retained)
  if (input.bypassRetainedRecord && outcome.operationIdSpent) {
    forgetBypassedMobileStructuredSendOperation(operationKey, operation.operationId)
  }
  let released = false
  if (outcome.operationIdSpent) {
    try {
      await clearMobileStructuredSendOperation({
        operationKey,
        operationId: operation.operationId
      })
      released = true
    } catch {
      // A retained settled id can suppress a later identical send, never
      // duplicate this one; the next replay gets another clear chance.
    }
  }
  const withdrawnReplay =
    result.status === 'accepted' &&
    'queued' in result.value &&
    result.value.queued?.state === 'withdrawn'
  if (withdrawnReplay && operation.retained && !input.resendingAfterWithdrawal) {
    // The retained id's draft was withdrawn, so it never reached the agent:
    // this identical message is a new one, not a replay to swallow. A record
    // storage would not clear is bookkeeping: it is reported, never allowed to
    // block the send.
    const resent = await sendMobileStructuredAgentSessionMessage({
      ...input,
      resendingAfterWithdrawal: true,
      resendOperationKey: operationKey,
      ...(released ? {} : { bypassRetainedRecord: true as const })
    })
    // Only when the resend is known to have gone out; an unconfirmed one may not have.
    if (!released && (resent === 'accepted' || resent === 'queued')) {
      input.onError("Sent, but this phone couldn't update its record of sent messages.")
    }
    return resent
  }
  if (withdrawnReplay) {
    // Not resent: no card and no bubble holds the text, so it goes back to the
    // composer rather than vanishing.
    input.onError('Message not sent')
    return 'rejected'
  }
  if (outcome.error !== null) {
    input.onError(outcome.error)
  }
  if (
    outcome.outcome === 'accepted' &&
    result.status === 'accepted' &&
    'submission' in result.value
  ) {
    input.onAccepted?.(result.value.submission.clientMessageId)
  }
  return outcome.outcome
}

/** The id a resend past an uncleared record goes out under: the one this app run already used
 *  for this text, replayed, or a fresh one remembered for the next retry. */
function bypassOperation(
  operationKey: string,
  payloadFingerprint: string,
  attachmentPaths: string[]
): Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>> {
  const bypassed = bypassedMobileStructuredSendOperationId(operationKey)
  const operationId = bypassed ?? structuredSessionOperationId()
  if (bypassed === undefined) {
    rememberBypassedMobileStructuredSendOperation(operationKey, operationId)
  }
  return {
    operationKey,
    operationId,
    retained: bypassed !== undefined,
    payloadFingerprint,
    attachmentPaths
  }
}

/** A remembered bypassed id handed back to the saved record once storage works again: the record
 *  replays it, and memory lets it go. Should storage fail again, memory keeps replaying it. */
async function adoptBypassedOperation(input: {
  operationKey: string
  callerIdentity: string
  payloadFingerprint: string
  attachmentPaths: string[]
}): Promise<Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>> {
  const operationId = bypassedMobileStructuredSendOperationId(input.operationKey)
  if (operationId === undefined) {
    throw new Error('No bypassed send id to adopt')
  }
  try {
    const recorded = await getOrCreateMobileStructuredSendOperation({
      ...input,
      createOperationId: () => operationId
    })
    if (recorded.operationId === operationId) {
      forgetBypassedMobileStructuredSendOperation(input.operationKey, operationId)
    }
    return { ...recorded, retained: true }
  } catch {
    return bypassOperation(input.operationKey, input.payloadFingerprint, input.attachmentPaths)
  }
}
