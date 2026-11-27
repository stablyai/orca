import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnJoin } from '../../../../shared/agent-session/journal/agent-session-journal-types'
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256
export const MAX_CODEX_RECORDED_TURN_ENDS = 64

export type CodexExpectedDispatchReceipt = {
  threadId: string
  via: AgentJournalTurnJoin
  turnId?: string
  key: string | null
  /** A turn start's turns already running when it was written: Codex may steer it into one, and
   *  an echo in one of them joined that turn, which another send opened. */
  runningTurnIds?: readonly string[]
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
  // Each turn's first armed send echoed into it: the one that opened it.
  const firstEchoes = new Map<string, string>()
  // How each echoed send was taken, kept past its settling: a repeated echo (Codex sends the item's
  // start and completion) after a failed first write reads the same join.
  const echoedJoins = new Map<string, AgentJournalTurnJoin>()
  const sentVia = (id: string, echoTurnId?: string): AgentJournalTurnJoin | null => {
    const entry = armed.get(id)
    const via = entry?.turn?.via ?? entry?.expected?.via ?? null
    // Echoed into a turn that was already running when the start was written: it joined it.
    return via === 'start' &&
      echoTurnId !== undefined &&
      entry?.expected?.runningTurnIds?.includes(echoTurnId)
      ? 'steer'
      : via
  }
  return {
    sentVia,
    /** How a send was taken, read at its echo into a turn: a start echoed into a turn an earlier
     *  send's echo already opened joined it (`steer`), even when Orca never learned that turn's id
     *  (its start's reply timed out). Records the turn's first echoed send. */
    echoedVia: (id: string, threadId: string, turnId: string): AgentJournalTurnJoin | null => {
      const key = turnKey(threadId, turnId)
      const first = firstEchoes.get(key)
      if (first === undefined) {
        firstEchoes.set(key, id)
        if (firstEchoes.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
          firstEchoes.delete(firstEchoes.keys().next().value ?? '')
        }
      }
      const via = sentVia(id, turnId) ?? echoedJoins.get(id) ?? null
      const taken = via === 'start' && first !== undefined && first !== id ? 'steer' : via
      if (taken !== null) {
        echoedJoins.set(id, taken)
        if (echoedJoins.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
          echoedJoins.delete(echoedJoins.keys().next().value ?? '')
        }
      }
      return taken
    },
    expect: (
      id: string,
      threadId: string,
      via: AgentJournalTurnJoin,
      input: readonly Record<string, unknown>[],
      turnId?: string,
      runningTurnIds?: readonly string[]
    ) => {
      const entry = armed.get(id)
      if (entry) {
        entry.expected = {
          threadId,
          via,
          key: compareKey(input),
          ...(turnId ? { turnId } : {}),
          ...(runningTurnIds?.length ? { runningTurnIds } : {})
        }
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
      firstEchoes.clear()
      echoedJoins.clear()
    }
  }
}
