import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'

/** Sends awaiting their echo. A send whose echo never arrives is
 *  retired by the journal's pending-submission recovery on exit, not from here. */
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256

export type CodexDispatchRequestOrigin = {
  requestedAt: number
  sequence: number
}

/**
 * Which sends this session is still waiting to hear back about, keyed by the
 * client message id Codex echoes on the user message.
 *
 * Keyed rather than ordered on purpose: Codex coalesces a `turn/start` issued
 * while a turn is running into that turn, so two sends can share one turn id and
 * their echoes arrive far apart. Queue position identifies neither.
 */
export type CodexDispatchEchoes = {
  /** Arms settlement for a send about to be written; false preserves older waits at capacity. */
  arm: (clientMessageId: string, requestedAt?: number) => boolean
  /** True once, for a send this session armed and has not yet settled. */
  settle: (clientMessageId: string) => boolean
  /** Drops an armed send whose write never reached the provider. */
  disarm: (clientMessageId: string) => void
  /** Submission origin for this exact send, retained until its echo settles it. */
  requestOrigin: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  /** Highest causal sequence assigned to a dispatch in this session. */
  latestSequence: () => number
  clear: () => void
  readonly size: number
}

export function createCodexDispatchEchoes(): CodexDispatchEchoes {
  const armed = new Map<string, { requestedAt: number | null; sequence: number }>()
  let nextSequence = 0
  return {
    arm(clientMessageId, requestedAt) {
      const existing = armed.get(clientMessageId)
      if (existing) {
        if (existing.requestedAt === null && requestedAt !== undefined) {
          existing.requestedAt = requestedAt
        }
        return true
      }
      if (armed.size >= MAX_CODEX_PENDING_DISPATCH_ECHOES) {
        return false
      }
      armed.set(clientMessageId, { requestedAt: requestedAt ?? null, sequence: nextSequence++ })
      return true
    },
    settle: (clientMessageId) => armed.delete(clientMessageId),
    disarm: (clientMessageId) => void armed.delete(clientMessageId),
    requestOrigin: (clientMessageId) => {
      const origin = armed.get(clientMessageId)
      return origin?.requestedAt === null || origin === undefined
        ? null
        : { requestedAt: origin.requestedAt, sequence: origin.sequence }
    },
    latestSequence: () => nextSequence - 1,
    clear: () => {
      armed.clear()
      nextSequence = 0
    },
    get size() {
      return armed.size
    }
  }
}

/** The user-message echo a settlement is read off, or null for any other item. */
export function readCodexDispatchEcho(
  item: { type: string; id: string } & Record<string, unknown>,
  identity: AgentJournalItemIdentity
): { clientMessageId: string; providerIdentity: AgentJournalItemIdentity } | null {
  if (item.type !== 'userMessage' || identity.provider !== 'codex') {
    return null
  }
  const clientMessageId = item.clientId
  return typeof clientMessageId === 'string' && clientMessageId.length > 0
    ? { clientMessageId, providerIdentity: identity }
    : null
}
