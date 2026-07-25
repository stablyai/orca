// Tracks in-flight ACP permission requests between the agent (main) and the
// approval card (renderer).
//
// An ACP agent blocks its turn until the client answers `session/request_permission`,
// so every request must reach exactly one of: an operator choice, or a cancel.
// The dangerous failure is a request that is silently dropped — the agent would
// wait forever. So teardown paths (unsubscribe, window destroyed) explicitly
// cancel anything outstanding rather than letting the promise leak.
//
// Deliberately has no timeout: an operator reading a `rm -rf` approval should
// not have it auto-answered because they took too long. Unanswered requests are
// resolved by teardown, not by a clock.

import { buildAcpApprovalCard, type AcpPermissionRequestParams } from '../acp/acp-permission-bridge'

export type AcpPermissionPrompt = {
  /** Correlates the renderer's answer back to the blocked agent request. */
  requestId: string
  subscriptionId: string
  title: string
  detail?: string
  options: { label: string; send: string }[]
}

export type AcpPermissionRegistry = {
  /** Surface a request to the operator; resolves to the chosen ACP optionId, or
   *  null to cancel. Returns null immediately when the request has no
   *  answerable options. */
  request: (args: {
    senderId: number
    subscriptionId: string
    params: AcpPermissionRequestParams
  }) => Promise<string | null>
  /** Answer a pending request. Returns false when the id is unknown (a stale
   *  answer after teardown, or a duplicate click). */
  respond: (requestId: string, optionId: string | null) => boolean
  /** Cancel everything owned by one subscription (chat view closed). */
  cancelSubscription: (senderId: number, subscriptionId: string) => number
  /** Cancel everything owned by one renderer (window closed/reloaded). */
  cancelSender: (senderId: number) => number
  readonly pendingCount: number
}

type PendingEntry = {
  senderId: number
  subscriptionId: string
  resolve: (optionId: string | null) => void
}

export function createAcpPermissionRegistry(
  emit: (senderId: number, prompt: AcpPermissionPrompt) => void
): AcpPermissionRegistry {
  const pending = new Map<string, PendingEntry>()
  let nextId = 1

  function settle(requestId: string, optionId: string | null): boolean {
    const entry = pending.get(requestId)
    if (entry == null) {
      return false
    }
    pending.delete(requestId)
    entry.resolve(optionId)
    return true
  }

  function cancelWhere(predicate: (entry: PendingEntry) => boolean): number {
    // Collect first: settle() deletes from `pending`, and resolving a promise can
    // run continuations that touch the registry.
    const doomed: string[] = []
    for (const [requestId, entry] of pending) {
      if (predicate(entry)) {
        doomed.push(requestId)
      }
    }
    for (const requestId of doomed) {
      settle(requestId, null)
    }
    return doomed.length
  }

  return {
    request({ senderId, subscriptionId, params }) {
      const card = buildAcpApprovalCard(params)
      if (card == null) {
        // Nothing answerable — cancel rather than invent a grant.
        return Promise.resolve(null)
      }
      const requestId = `acp-perm-${nextId++}`
      return new Promise<string | null>((resolve) => {
        pending.set(requestId, { senderId, subscriptionId, resolve })
        try {
          emit(senderId, {
            requestId,
            subscriptionId,
            title: card.title,
            detail: card.detail,
            options: card.options
          })
        } catch {
          // A destroyed renderer cannot show the card, so the request can never
          // be answered — cancel it now instead of blocking the agent forever.
          settle(requestId, null)
        }
      })
    },

    respond(requestId, optionId) {
      return settle(requestId, optionId)
    },

    cancelSubscription(senderId, subscriptionId) {
      return cancelWhere(
        (entry) => entry.senderId === senderId && entry.subscriptionId === subscriptionId
      )
    },

    cancelSender(senderId) {
      return cancelWhere((entry) => entry.senderId === senderId)
    },

    get pendingCount() {
      return pending.size
    }
  }
}
