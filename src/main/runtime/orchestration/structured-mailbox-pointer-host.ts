/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the read and
 * the send and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'

/** Per-dispatch so one worker's nudges cannot exhaust the shared runtime operation-ledger budget. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/**
 * The same budget for direct peer mail, which is addressed to the worker's own handle and has no
 * dispatch to scope to.
 *
 * A separate key rather than a reshaped one: the ledger is keyed on (callerKey, operationId), so
 * changing the dispatch key's shape would orphan every nudge already in flight under the old one.
 */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/**
 * The idle gate for a structured session, read off its FULL reduced timeline.
 *
 * Never a bounded page. Settlement tombstones the running turn's lifecycle item rather than
 * rewriting it to `completed`, so on any tail window an idle session and a busy one whose
 * lifecycle item scrolled off look identical — and idle-with-history is the normal steady state of
 * a working agent. Shared so the pointer lane and group addressing cannot disagree about it.
 */
export function readStructuredSessionGateFacts(
  sessionId: string
): StructuredSessionGateFacts | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    return structuredSessionGateFacts(host.journalSnapshot(sessionId).items)
  } catch (error) {
    // Not attached is a retain reason, not a failure; anything else is still unreadable.
    if ((error as Error)?.message !== AGENT_SESSION_NOT_ATTACHED.code) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    readGateFacts(sessionId) {
      return readStructuredSessionGateFacts(sessionId)
    },

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
      )
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const result = await host.send(
        {
          callerKey: input.dispatchId
            ? structuredPointerCallerKey(input.dispatchId)
            : structuredSessionPointerCallerKey(input.sessionId)
        },
        {
          envelope: {
            sessionId: input.sessionId,
            clientOperationId: input.operationId,
            expectedRuntimeFence: input.expectedRuntimeFence,
            payloadFingerprint: input.payloadFingerprint
          },
          body: input.body,
          // The recorded unknown is the only thing that unlocks a redispatch of the same id.
          retryUnknown: true
        }
      )
      if (!result.ok) {
        return result.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
          ? { kind: 'unattached' }
          : { kind: 'sent', state: 'rejected' }
      }
      // `pending` is not yet an acknowledgement; only `accepted` may consume mail.
      const state = result.value.submission.dispatchState
      return {
        kind: 'sent',
        state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
      }
    }
  }
}
