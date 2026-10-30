import { MAIL_CALLER, selectMailCreationOperation } from './structured-mail-operation-identity'
import { queuedMessagesPublishedBytes } from '../../native-chat/agent-session-wire/structured-agent-session-queued-published-bytes'
import {
  readMailCreationHistory,
  observeMailCreationHistory
} from './structured-mail-creation-history'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'
import { structuredSessionGateFacts } from './structured-session-pointer-delivery'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

/** One internal seam for ordinary command acceptance; no provider-consumption acknowledgement. */
export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  const readCreation: StructuredMailboxPointerHost['readCreation'] = (operationId, _sessionId) => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return 'unknown'
    }
    const read = host.deps.store.readCommandReceipt({ kind: 'global' }, operationId)
    if (read.verdict === 'absent') {
      return 'absent'
    }
    if (read.verdict !== 'readable') {
      return 'unknown'
    }
    const receipt = read.receipt
    const target = resolveLineageRunningSession(
      conversationRecordReader(host.deps.store),
      receipt.sessionId
    )
    const validCaller = receipt.callerKey === MAIL_CALLER
    const created =
      receipt.status === 'accepted' &&
      receipt.result.kind === 'queued-draft' &&
      receipt.result.messageId === operationId
    return target.kind === 'here' &&
      validCaller &&
      receipt.method === 'agentSession.send' &&
      created
      ? 'accepted'
      : 'unknown'
  }
  return {
    readCreation,
    selectCreation: (source) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { operationId: '', state: 'unknown', evidence: '' }
      }
      return selectMailCreationOperation(host, source)
    },
    observeHistory: (listener) => {
      const host = getStructuredAgentSessionHost()
      return host && observeMailCreationHistory(host, listener)
    },
    readHistory: (sessionId) => {
      const host = getStructuredAgentSessionHost()
      return host ? readMailCreationHistory(host, sessionId) : { members: new Set(), opaque: true }
    },
    admission: (sessionId) => {
      const host = getStructuredAgentSessionHost()
      const record = host?.deps.store.getRecord(sessionId)
      if (
        !host ||
        !record ||
        resolveLineageRunningSession(conversationRecordReader(host.deps.store), sessionId).kind !==
          'here'
      ) {
        return null
      }
      const journal = host.queuedMailJournal(sessionId)
      return {
        owner: host,
        generation: JSON.stringify([
          record.sessionId,
          record.location,
          record.lease.runtimeFence,
          journal?.epoch
        ]),
        queuedBytes: journal ? queuedMessagesPublishedBytes(journal) : 0
      }
    },
    currentFence: (sessionId) =>
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ?? null,
    send: async (input) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        callerKey: MAIL_CALLER,
        sessionId: input.sessionId,
        turn: {
          body: input.body,
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence,
          delivery: 'queue',
          queueAlways: true,
          mailSource: input.mailSource,
          beforeRun: input.beforeRun
        }
      })
      if (outcome.kind === 'queued') {
        return { kind: 'queued' }
      }
      if (outcome.kind === 'refused') {
        if (outcome.refusal.details?.reason === 'queueTooLarge') {
          return { kind: 'capacity' }
        }
        if (
          outcome.refusal.code === 'agent_session_operation_unknown' ||
          outcome.refusal.code === 'execution_owner_reconciling'
        ) {
          return { kind: 'retry' }
        }
      }
      return { kind: 'held' }
    }
  }
}

export const structuredPointerCallerKey = (dispatchId: string): string =>
  `trusted-local:orchestration:${dispatchId}`
export const structuredSessionPointerCallerKey = (sessionId: string): string =>
  `trusted-local:orchestration:session:${sessionId}`

export async function readStructuredSessionGateFacts(sessionId: string) {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const snapshot = await host.journalSnapshot(sessionId)
    return structuredSessionGateFacts(snapshot.items, host.currentWork(sessionId)?.scope)
  } catch {
    return null
  }
}
