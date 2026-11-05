import { describe, expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { isolateJournalTransition } from './journal-reducer-transition'
import type { JournalRow } from './journal-row-schema'
import { JournalNewestTurn } from './journal-newest-turn'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

function usageLimit(turnItemId: string) {
  return {
    kind: 'item' as const,
    itemId: `limit:${turnItemId}`,
    revision: 1,
    body: {
      kind: 'status' as const,
      tone: 'error' as const,
      ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), { surface: 'row' })
    },
    turnScope: { kind: 'turn' as const, turnItemId }
  }
}

/** Live failure position next to what a restore over the same items would derive. */
function failureFold() {
  const state = createJournalReducerState('session', 'epoch')
  const revisions = new Map<string, number>()
  const apply = (
    row: Omit<
      Extract<JournalRow, { kind: 'item' }>,
      'v' | 'epoch' | 'seq' | 'ts' | 'fence' | 'revision'
    >
  ) => {
    const revision = (revisions.get(row.itemId) ?? 0) + 1
    revisions.set(row.itemId, revision)
    const seq = state.lastSequence + 1
    applyJournalRow(state, { v: 4, epoch: 'epoch', seq, ts: seq, fence: 1, revision, ...row })
    return seq
  }
  const turn = (itemId: string, turnId = itemId, outcome: 'failure' | 'success' = 'failure') =>
    apply({ kind: 'item', itemId, body: { kind: 'turn', turnId, state: 'completed', outcome } })
  const command = (id: string) => {
    const { itemId, turnId } = structuredAgentSessionCommandTurn(id)
    return { itemId, settle: () => turn(itemId, turnId) }
  }
  return {
    state,
    apply,
    turn,
    command,
    live: () => journalInputOrder(state).newestTurn.failure(),
    restored: () => new JournalNewestTurn(state).failure() > 0
  }
}

describe('which failure holds the queue beneath refused commands', () => {
  it('releases when the failure beneath a refused command is revised to success', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    f.command('refused').settle()
    expect(f.live()).toBe(failedAt)
    f.turn('ordinary', 'ordinary', 'success')
    expect([f.live(), f.restored()]).toEqual([0, false])
  })

  it("holds on an older command's late usage limit beneath a newer refused command", () => {
    const f = failureFold()
    const older = f.command('older')
    older.settle()
    f.command('newer').settle()
    expect(f.live()).toBe(0)
    const reported = f.apply(usageLimit(older.itemId))
    expect([f.live(), f.restored()]).toEqual([reported, true])
  })

  it('holds on a usage limit saved before its command turn row', () => {
    const f = failureFold()
    const command = f.command('out-of-order')
    f.apply(usageLimit(command.itemId))
    const settled = command.settle()
    expect([f.live(), f.restored()]).toEqual([settled, true])
  })

  it('leaves the live failure untouched when a draft adding its evidence is discarded', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    const command = f.command('refused')
    command.settle()
    const pending = isolateJournalTransition(f.state, (draft) =>
      applyJournalRow(draft, {
        v: 4,
        epoch: 'epoch',
        seq: 9,
        ts: 9,
        fence: 1,
        ...usageLimit(command.itemId)
      })
    )
    expect(journalInputOrder(pending.state).newestTurn.failure()).toBe(9)
    expect(f.live()).toBe(failedAt)
  })
})
