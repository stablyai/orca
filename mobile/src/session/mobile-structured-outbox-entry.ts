import * as ExpoCrypto from 'expo-crypto'
import type { AgentSessionWireRefusalCode } from '../../../src/shared/agent-session-wire'
import {
  classifyStructuredAgentSessionSendFailure,
  createStructuredAgentSessionOutboxEntry,
  requeueStructuredAgentSessionSendRefusal,
  type StructuredAgentSessionAttachment,
  type StructuredAgentSessionOutboxEntry
} from '../../../src/shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../src/shared/structured-agent-session-mutation'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

export {
  createStructuredAgentSessionOutboxEntry as createMobileStructuredOutboxEntry,
  reconcileStructuredAgentSessionOutbox as reconcileMobileStructuredOutbox,
  structuredAgentSessionSendBody as mobileStructuredSendBody,
  updateStructuredAgentSessionOutboxEntry as updateMobileStructuredOutboxEntry
} from '../../../src/shared/structured-agent-session-outbox'

function mobileStructuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => ExpoCrypto.randomUUID())
}

export function createQueuedMobileStructuredOutboxEntry(args: {
  sessionId: string
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
}): StructuredAgentSessionOutboxEntry {
  return createStructuredAgentSessionOutboxEntry({
    ...args,
    clientMessageId: mobileStructuredSessionOperationId(),
    queuedAt: Date.now()
  })
}

export function requeueMobileStructuredSendRefusal(
  entry: StructuredAgentSessionOutboxEntry,
  code: AgentSessionWireRefusalCode
): StructuredAgentSessionOutboxEntry {
  return requeueStructuredAgentSessionSendRefusal(entry, code, mobileStructuredSessionOperationId)
}

export function isMobileStructuredDeliveryUnknown(error: unknown): boolean {
  return (
    classifyStructuredAgentSessionSendFailure(
      error,
      (candidate) => isRpcDeliveryUnknown(candidate) || isLogicalClientCutoverError(candidate)
    ) === 'delivery-unknown'
  )
}
