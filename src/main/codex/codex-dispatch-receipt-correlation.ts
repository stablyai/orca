import type {
  AgentJournalItemIdentity,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256
export const MAX_CODEX_RECORDED_TURN_ENDS = 64

export type CodexExpectedDispatchReceipt = {
  threadId: string
  via: AgentJournalTurnJoin
  turnId?: string
  key: string | null
}

function compareKey(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null
  }
  let text = ''
  let images = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      text += item.text
    }
    if (item.type === 'image' || item.type === 'localImage') {
      images++
    }
  }
  return JSON.stringify([text, images])
}

/** Live correlation shares the dispatch entries; it never infers delivery from a missing item. */
export function createCodexDispatchReceiptCorrelation(
  armed: ReadonlyMap<
    string,
    {
      answeredAt?: number
      turnEnded?: true
      expected?: CodexExpectedDispatchReceipt
      turn?: { threadId: string; turnId: string; via: AgentJournalTurnJoin }
    }
  >
) {
  const receipts = new Map<
    string,
    { id: string; identity: Extract<AgentJournalItemIdentity, { provider: 'codex' }> }
  >()
  const seenReceipts = new Map<string, string | null>()
  const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId])
  return {
    expect: (
      id: string,
      threadId: string,
      via: AgentJournalTurnJoin,
      input: readonly Record<string, unknown>[],
      turnId?: string
    ) => {
      const entry = armed.get(id)
      if (entry) {
        entry.expected = { threadId, via, key: compareKey(input), ...(turnId ? { turnId } : {}) }
      }
    },
    receipt: (
      identity: Extract<AgentJournalItemIdentity, { provider: 'codex' }>,
      content: unknown
    ) => {
      const key = JSON.stringify(identity)
      if (seenReceipts.has(key)) {
        return seenReceipts.get(key) ?? null
      }
      seenReceipts.set(key, null)
      if (seenReceipts.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
        seenReceipts.delete(seenReceipts.keys().next().value ?? '')
      }
      const eligible = [...armed].filter(
        ([, entry]) =>
          !entry.turnEnded &&
          entry.expected?.threadId === identity.threadId &&
          (entry.turn
            ? entry.turn.turnId === identity.turnId
            : entry.expected.via === 'steer'
              ? entry.expected.turnId === identity.turnId
              : entry.answeredAt === undefined)
      )
      const keyOfContent = compareKey(content)
      const matches = (entry: (typeof eligible)[number]) =>
        keyOfContent !== null && entry[1].expected?.key === keyOfContent
      const openers = eligible.filter(
        (entry) => entry[1].expected?.via === 'start' && matches(entry)
      )
      const opener = openers.length === 1 ? openers[0] : undefined
      const front = eligible.find(([, entry]) => entry.expected?.via === 'steer')
      const steer = front && matches(front) ? front : undefined
      // Only a matching causal frontier can settle live; a boundary must await its answer.
      const pending = [...armed].filter(
        ([, entry]) =>
          !entry.turn &&
          entry.answeredAt === undefined &&
          entry.expected?.threadId === identity.threadId
      )
      const deferred =
        !opener && !steer && pending.length === 1 && matches(pending[0]) ? pending[0] : undefined
      const waiting = opener && !opener[1].turn && !steer ? opener : deferred
      if (waiting) {
        receipts.set(turnKey(identity.threadId, identity.turnId), { id: waiting[0], identity })
        if (receipts.size > MAX_CODEX_RECORDED_TURN_ENDS) {
          receipts.delete(receipts.keys().next().value ?? '')
        }
        return null
      }
      const id = opener && steer ? null : (steer?.[0] ?? (opener?.[1].turn ? opener[0] : null))
      seenReceipts.set(key, id)
      return id
    },
    take: (id: string, threadId: string, turnId: string) => {
      const key = turnKey(threadId, turnId)
      const receipt = receipts.get(key) ?? null
      receipts.delete(key)
      if (receipt?.id !== id) {
        return null
      }
      seenReceipts.set(JSON.stringify(receipt.identity), id)
      return receipt.identity
    },
    clear: () => {
      receipts.clear()
      seenReceipts.clear()
    }
  }
}
