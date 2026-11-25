import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredAgentTurnAnchors } from '../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import { isRootTurnRecord, isRootUserMessage, turnMessages } from './bot-turn-messages'

// The per-turn scan this replaced (STA-18015), kept as the oracle.
function scannedTurnMessages(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  turns: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[][] {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const messages: { item: AgentJournalRenderItem; index: number }[] = []
  const previousRecord = new Map<string, number>()
  let lastRecord = -1
  items.forEach((item, index) => {
    if (isRootUserMessage(item)) {
      messages.push({ item, index })
    } else if (isRootTurnRecord(item)) {
      previousRecord.set(item.itemId, lastRecord)
      lastRecord = index
    }
  })
  return turns.map((turn) => {
    const opener = anchors.get(turn.itemId)
    const after = previousRecord.get(turn.itemId) ?? -1
    return messages.flatMap(({ item, index }) =>
      (item.itemId === opener && index > after) ||
      (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turn.itemId)
        ? [item]
        : []
    )
  })
}

const user = { kind: 'message', role: 'user', blocks: [] }
const workerMail = {
  ...user,
  from: {
    sessionId: 'worker-1',
    orchestration: { message: 'mail-notice', messages: [{ messageId: 'mail-1' }] }
  }
}

/** A long chat mixing every shape attribution meets: typed and Codex-aliased openers, steers,
 *  pending and unknown held sends, worker-mail-only runs, commands, subagent and unscoped rows. */
function chat(turnCount: number) {
  let seed = turnCount
  const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  let sequence = 0
  const items: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  const row = (itemId: string, body: unknown, extra: Partial<AgentJournalRenderItem> = {}) =>
    items.push(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the readers read.
      {
        itemId,
        revision: 1,
        sequence: ++sequence,
        observedAt: sequence,
        body,
        ...extra
      } as AgentJournalRenderItem
    )
  const send = (n: number, fields: Partial<AgentJournalSubmission>): string => {
    submissions.push({
      clientMessageId: `c${n}`,
      fence: 1,
      payloadFingerprint: `f${n}`,
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      submittedAt: n,
      resolvedAt: n,
      ...fields
    })
    return agentJournalSubmissionKey(`c${n}`)
  }
  for (let n = 0; n < turnCount; n++) {
    const shape = random()
    let opener: string | null = `u${n}`
    if (shape < 0.08) {
      // Held: handed over, never echoed; the turn record names no opener.
      opener = null
      row(send(n, { dispatchState: shape < 0.04 ? 'pending' : 'unknown', resolvedAt: null }), user)
    } else if (shape < 0.18) {
      // Worker mail only: a run no person sent.
      row(`u${n}`, workerMail)
      if (random() < 0.5) {
        row(`w${n}`, workerMail)
      }
    } else if (shape < 0.28) {
      // Codex: the provider key reuses the send's.
      row(send(n, { providerItemId: `u${n}` }), user)
    } else if (shape < 0.32) {
      row(`u${n}`, { ...user, command: { name: 'compact' } })
    } else if (shape < 0.36) {
      row(`u${n}`, user, { turnScope: { kind: 'unknown' } })
    } else if (shape < 0.4) {
      opener = null
    } else if (shape < 0.44) {
      // Opens the turn it is also scoped to.
      row(`u${n}`, user, { turnScope: { kind: 'turn', turnItemId: `t${n}` } })
    } else {
      row(`u${n}`, user)
    }
    row(`t${n}`, {
      kind: 'turn',
      turnId: `p${n}`,
      state: n === turnCount - 1 ? 'running' : 'completed',
      ...(opener && random() < 0.9 ? { userItemId: opener } : {})
    })
    if (random() < 0.15) {
      row(`s${n}`, user, { turnScope: { kind: 'turn', turnItemId: `t${n}` } })
    }
    if (random() < 0.05) {
      // Steered into an older turn, or one not loaded.
      const into = random() < 0.5 ? `t${Math.floor(random() * n)}` : `gone${n}`
      row(`late${n}`, user, { turnScope: { kind: 'turn', turnItemId: into } })
    }
    if (random() < 0.05) {
      row(`sub${n}`, user, { agentId: 'sub-1' })
    }
    row(`a${n}`, { kind: 'message', role: 'assistant', blocks: [] })
  }
  return { items, submissions }
}

const ids = (turns: AgentJournalRenderItem[][]) => turns.map((turn) => turn.map((m) => m.itemId))

describe('turnMessages', () => {
  it.each([1_000, 10_000])('matches the per-turn scan on a %i-turn chat', (turnCount) => {
    const { items, submissions } = chat(turnCount)
    const records = items.filter(isRootTurnRecord)
    // Newest first, as attribution asks, plus a turn named twice and one not loaded.
    const turns = [
      ...records.toReversed(),
      records[0],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a turn record outside the loaded rows.
      {
        itemId: 'gone0',
        revision: 1,
        sequence: 0,
        observedAt: 0,
        body: { kind: 'turn' }
      } as AgentJournalRenderItem
    ]
    const expected = ids(scannedTurnMessages(items, submissions, turns))
    // The chat exercises openers and steers, not only empty turns.
    expect(expected.filter((turn) => turn.length > 0).length).toBeGreaterThan(turnCount / 2)
    expect(expected.some((turn) => turn.length > 1)).toBe(true)
    expect(ids(turnMessages(items, submissions, turns))).toEqual(expected)
  })
})
