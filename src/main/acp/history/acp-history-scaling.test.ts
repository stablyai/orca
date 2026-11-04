import { afterEach, expect, it } from 'vitest'

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import '../../../shared/agent-session/failures/agent-session-failure'
import '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  AGENT,
  SESSION,
  NAMESPACE,
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerTurnItemId
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import '../../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import '../../native-chat/agent-session-timeline/provider-timeline-history'
import '../../native-chat/agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import '../../native-chat/agent-session-wire/structured-agent-session-unfinished-work'
import '../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import './acp-history-scaling-counts.test-fixture'
import './acp-history-scaling-operations.test-fixture'
import './acp-history-catch-up'
import './acp-history-catch-up.test-support'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import { matchAcpHistoryTurns } from './acp-history-turn-matching'
import { acpNamedTextKey } from '../acp-turn-messages'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import '../acp-dialects/grok-dialect'
import '../../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import '../../native-chat/agent-session-journal/journal-lifecycle-mutation'

afterEach(closeProviderTimelineRigs)
const scope: AcpHistoryScope = {
  agent: AGENT,
  sessionId: SESSION,
  providerSessionId: NAMESPACE,
  identity: 'user-message-id',
  dialect: OPENCODE_ACP_DIALECT
}
const frame = (
  update: Record<string, unknown>,
  meta?: Record<string, unknown>
): AcpLoadHistoryFrame => ({
  method: 'session/update',
  params: { sessionId: NAMESPACE, update, ...(meta ? { _meta: meta } : {}) }
})
const user = (id: string, text: string) =>
  frame({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text } })
type Rig = Awaited<ReturnType<typeof openProviderTimelineRig>>

async function native(rig: Rig, id: string, text: string, proof?: string) {
  await rig.journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: 1
  })
  await rig.journal.resolveDispatch({
    clientMessageId: id,
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  rig.assembler.apply({
    type: 'input.accepted',
    clientMessageId: id,
    requestedAt: 1000,
    join: { turn: id }
  })
  rig.assembler.apply({ type: 'turn.open', turn: id, at: 1000 })
  if (proof) {
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: acpNamedTextKey(proof, 'assistant') },
      channel: 'assistant',
      text: 'answer',
      join: { thread: NAMESPACE, turn: id }
    })
    rig.assembler.flush()
  }
  rig.assembler.apply({ type: 'turn.end', turn: id, state: 'completed', at: 1100 })
  await rig.rows()
}

it('preserves regressing floors, future exact reservations, ties and non-consuming misses', async () => {
  const rig = await openProviderTimelineRig()
  for (const [id, text, proof] of [
    ['a', 'a'],
    ['b', 'b'],
    ['B', 'high'],
    ['tie', 'tie'],
    ['empty', ''],
    ['end', 'end']
  ]) {
    await native(rig, id, text, proof)
  }
  const items = new Map((await rig.rows()).map((row) => [row.itemId, row]))
  const tie = items.get(providerTurnItemId('tie'))!
  const adopted = {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: AGENT,
      sessionId: NAMESPACE,
      recordId: 'Q'
    }),
    sequence: tie.sequence,
    revision: 1,
    observedAt: 0,
    body: {
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'retained' }]
    }
  }
  items.set(adopted.itemId, adopted)
  const before = structuredClone([...items.values()])
  const frames = [
    user('A', 'a'),
    user('B', 'high'),
    user('A', 'a'),
    user('C', 'b'),
    user('O', 'tie'),
    user('Q', 'adopted'),
    user('P', 'tie'),
    user('U', ''),
    user('end', 'end'),
    user('B', 'high'),
    user('Z', 'end')
  ]
  const candidates = acpHistoryTurns(frames, scope.identity)
    .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
    .map((source) => ({ source, items: translateHistoryTurn(scope, source) }))
  const result = matchAcpHistoryTurns(scope, { items }, candidates, null, new Set(), () => {})
  expect([...result.matched]).toEqual([
    ['B', 2],
    ['end', 5],
    ['A', 0],
    ['C', 1],
    ['P', 3],
    ['U', 4]
  ])
  expect(result.kind.get('Q')).toBe('adopted')
  expect(result.kind.has('O')).toBe(false)
  expect(result.kind.has('Z')).toBe(false)
  expect([...items.values()]).toEqual(before)
})

it('imports a whole historical turn with more than 128 still-open message segments', () => {
  const frames = [user('long-turn', 'Review the repository')]
  for (let index = 0; index < 160; index += 1) {
    frames.push(
      frame({
        sessionUpdate: 'agent_message_chunk',
        messageId: `answer-${index}`,
        content: { type: 'text', text: 'Retained segment' }
      })
    )
  }
  frames.push(
    frame({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'answer-0',
      content: { type: 'text', text: ' and its late tail' }
    })
  )
  const turn = acpHistoryTurns(frames, scope.identity)[0]
  if (!turn || turn.turn === null) {
    throw new Error('Missing identified historical turn')
  }
  const items = translateHistoryTurn(scope, turn)
  const answers = items.flatMap((item) =>
    item.body.kind === 'message' && item.body.role === 'assistant' ? [item.body] : []
  )
  expect(answers).toHaveLength(160)
  expect(answers[0]).toMatchObject({
    blocks: [{ type: 'text', text: 'Retained segment and its late tail' }]
  })
})
