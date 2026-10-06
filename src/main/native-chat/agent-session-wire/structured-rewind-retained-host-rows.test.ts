import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import {
  AgentSessionRewindRecordSchema,
  type AgentSessionRewindRecord
} from '../../../shared/agent-session-rewind'
import {
  mergeRetainedHostLifecycleRows,
  retainedRowReplacement
} from './structured-rewind-retained-host-rows'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'
import type * as RewindJournalBody from './structured-rewind-journal-body'

vi.mock('./structured-rewind-journal-body', async (importOriginal) => {
  const actual = await importOriginal<typeof RewindJournalBody>()
  return { ...actual, restoreRewindJournalBody: vi.fn(actual.restoreRewindJournalBody) }
})

type Retained = AgentSessionRewindRecord['retained'][number]

const codexKey = (turnId: string, ordinal: number) =>
  agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId, ordinal })
const orcaKey = (clientMessageId: string) =>
  agentJournalItemKey({ provider: 'orca', clientMessageId })

function prose(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

function retained(itemId: string, body: AgentJournalItemBody, extra: Partial<Retained> = {}) {
  return { itemId, body, observedAt: 1, ...extra }
}

/** Provider history carries no scope or producer of its own. */
function providerItem(itemId: string, body: AgentJournalItemBody): Retained {
  return { itemId, body, observedAt: 2 }
}

const TURN_RECORD = orcaKey('turn-a')
const inTurnA = { kind: 'turn', turnItemId: TURN_RECORD }

describe('rewind keeps each retained row attributed', () => {
  it("keeps a held row's scope and producer, a subagent's row staying the subagent's", () => {
    const own = codexKey('a', 1)
    const child = codexKey('a', 2)
    const reference = [
      retained(TURN_RECORD, { kind: 'turn', turnId: 'a', state: 'completed' }),
      retained(own, prose('own'), { turnScope: inTurnA }),
      retained(child, prose('child'), {
        turnScope: inTurnA,
        agentId: 'child-thread',
        parentAgentId: 'root',
        producerKind: 'agent'
      })
    ]
    const merged = mergeRetainedHostLifecycleRows(reference, [
      providerItem(own, prose('own')),
      providerItem(child, prose('child'))
    ])
    expect(merged.find((item) => item.itemId === own)).toMatchObject({ turnScope: inTurnA })
    expect(merged.find((item) => item.itemId === own)?.agentId).toBeUndefined()
    expect(merged.find((item) => item.itemId === child)).toMatchObject({
      turnScope: inTurnA,
      agentId: 'child-thread',
      parentAgentId: 'root',
      producerKind: 'agent',
      // When the row was first seen, not when the rewind re-read it.
      observedAt: 1
    })
  })

  it("splices a command's turn, result and entry back, since provider history holds none", () => {
    const before = codexKey('a', 1)
    const commandTurn = orcaKey('command-turn:cmd-1')
    const commandResult = orcaKey('command-result:cmd-1')
    const entry = orcaKey('cmd-1')
    const reference = [
      retained(before, prose('before')),
      retained(entry, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      retained(commandTurn, { kind: 'turn', turnId: 'compact:cmd-1', state: 'completed' }),
      retained(
        commandResult,
        { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' },
        { turnScope: { kind: 'turn', turnItemId: commandTurn } }
      )
    ]
    const merged = mergeRetainedHostLifecycleRows(reference, [
      providerItem(before, prose('before'))
    ])
    expect(merged.map((item) => item.itemId)).toEqual([before, entry, commandTurn, commandResult])
    expect(merged.at(-1)?.turnScope).toEqual({ kind: 'turn', turnItemId: commandTurn })
  })

  it("keeps a newer Orca's row after a row the provider still holds, whatever that row's kind", () => {
    // A kind this build does not know, which the provider now returns in its own words.
    const future: AgentJournalItemBody = JSON.parse('{"kind":"future-item"}')
    const newer: AgentJournalItemBody = JSON.parse('{"kind":"plan-card","n":4}')
    const merged = mergeRetainedHostLifecycleRows(
      [
        retained(codexKey('turn-a', 2), prose('ok')),
        retained(codexKey('turn-a', 9), future),
        retained(orcaKey('u4'), newer)
      ],
      [
        providerItem(codexKey('turn-a', 2), prose('ok')),
        providerItem(codexKey('turn-a', 9), prose('provider now renders it'))
      ]
    )

    expect(merged.map((row) => row.itemId)).toEqual([
      codexKey('turn-a', 2),
      codexKey('turn-a', 9),
      orcaKey('u4')
    ])
    expect(merged[2]?.body).toEqual(newer)
  })

  it('places a provider item the old epoch never held in the turn record for its provider turn', () => {
    const commandTurn = orcaKey('command-turn:cmd-1')
    const reference = [
      retained(TURN_RECORD, { kind: 'turn', turnId: 'a', state: 'completed' }),
      retained(commandTurn, {
        kind: 'turn',
        turnId: 'compact:cmd-1',
        state: 'completed',
        providerTurnId: 'b'
      })
    ]
    const merged = mergeRetainedHostLifecycleRows(reference, [
      providerItem(codexKey('a', 1), prose('in a')),
      providerItem(codexKey('b', 1), prose('claimed by the command')),
      providerItem(codexKey('c', 1), prose('no record'))
    ])
    const scopeOf = (itemId: string) => merged.find((item) => item.itemId === itemId)?.turnScope
    expect(scopeOf(codexKey('a', 1))).toEqual(inTurnA)
    expect(scopeOf(codexKey('b', 1))).toEqual({ kind: 'turn', turnItemId: commandTurn })
    // No record to join: the rebuilt epoch places it by position.
    expect(scopeOf(codexKey('c', 1))).toBeUndefined()
  })
})

describe('the rebuilt epoch item for a retained row', () => {
  it('passes a placeable scope and a known producer through', () => {
    expect(
      retainedRowReplacement(
        retained(codexKey('a', 1), prose('x'), {
          turnScope: inTurnA,
          agentId: 'child',
          producerKind: 'agent',
          attempt: 2
        })
      )
    ).toMatchObject({ turnScope: inTurnA, agentId: 'child', producerKind: 'agent', attempt: 2 })
  })

  it('drops a scope and a producer kind this build cannot place', () => {
    const replacement = retainedRowReplacement(
      retained(codexKey('a', 1), prose('x'), {
        turnScope: { kind: 'future-kind' },
        producerKind: 'future-producer'
      })
    )
    expect(replacement.turnScope).toBeUndefined()
    expect(replacement.producerKind).toBeUndefined()
    expect(
      retainedRowReplacement(
        retained(codexKey('a', 1), prose('x'), { turnScope: { kind: 'turn' } })
      ).turnScope
    ).toBeUndefined()
  })

  it('leaves a row from an older record unscoped, for the rebuild to derive', () => {
    const replacement = retainedRowReplacement(retained(codexKey('a', 1), prose('x')))
    expect(replacement).not.toHaveProperty('turnScope')
    expect(replacement).not.toHaveProperty('agentId')
  })

  it('still reads a persisted record written before rows carried scope or producer', () => {
    const older = {
      operationId: 'op-1',
      callerKey: 'desktop',
      itemId: codexKey('b', 0),
      expectedEpoch: 'epoch-1',
      phase: 'prepared',
      retained: [{ itemId: codexKey('a', 1), body: prose('x'), observedAt: 1 }]
    }
    expect(AgentSessionRewindRecordSchema.safeParse(older).success).toBe(true)
  })
})

describe('rewind merge cost', () => {
  it('reads each merged row once to place the provider items it never held', () => {
    const turns = 400
    const providerItems = Array.from({ length: turns }, (_, index) =>
      providerItem(codexKey(`t${index}`, 1), prose(`answer ${index}`))
    )
    const reference = Array.from({ length: turns }, (_, index) =>
      retained(orcaKey(`turn-${index}`), {
        kind: 'turn',
        turnId: `t${index}`,
        state: 'completed'
      })
    )
    vi.mocked(restoreRewindJournalBody).mockClear()

    const merged = mergeRetainedHostLifecycleRows(reference, providerItems)

    expect(merged.find((item) => item.itemId === codexKey(`t${turns - 1}`, 1))).toMatchObject({
      turnScope: { kind: 'turn', turnItemId: orcaKey(`turn-${turns - 1}`) }
    })
    // A scan per provider item reads every merged row for each one: turns² reads.
    expect(vi.mocked(restoreRewindJournalBody).mock.calls.length).toBeLessThanOrEqual(merged.length)
  })
})
