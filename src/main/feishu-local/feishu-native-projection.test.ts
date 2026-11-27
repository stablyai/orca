import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { FeishuNativeProjection } from './feishu-native-projection'

it('projects only the stamped turn, revises calls and text in place, and excludes reasoning', () => {
  const projection = new FeishuNativeProjection()
  let sequence = 0
  const row = (
    itemId: string,
    body: AgentJournalRenderItem['body'],
    turn?: string,
    revision = 0
  ): AgentJournalRenderItem => ({
    itemId,
    body,
    revision,
    sequence: ++sequence,
    observedAt: 1000 + sequence,
    turnScope: turn ? { kind: 'turn', turnItemId: turn } : { kind: 'thread' }
  })
  const apply = (...items: AgentJournalRenderItem[]) =>
    projection.apply({
      type: 'batch',
      sessionId: 'session',
      batch: {
        cursor: { epoch: 'epoch', sequence },
        items,
        removedItemIds: [],
        submissions: []
      }
    })
  apply(
    row('user', {
      kind: 'message',
      role: 'user',
      blocks: [],
      connectorDelivery: {
        account: 'account',
        conversation: { source: 'feishu-local', externalId: 'lane' },
        deliveryId: 'om_one'
      }
    }),
    row('turn', {
      kind: 'turn',
      turnId: 'provider-turn',
      state: 'running',
      userItemId: 'user',
      startedAt: 1000
    })
  )
  apply(
    row(
      'text',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Checking' }] },
      'turn'
    ),
    row(
      'reasoning',
      { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: 'Private reasoning' }] },
      'turn'
    ),
    row(
      'old',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Other turn' }] },
      'old-turn'
    ),
    row(
      'tool',
      {
        kind: 'tool-call',
        name: 'web_search',
        callId: 'call',
        input: { query: 'Orca' },
        state: 'running'
      },
      'turn'
    )
  )
  expect(projection.project('other-account', 'lane')).toBeNull()
  expect(projection.project('account', 'other-lane')).toBeNull()
  expect(projection.project('account', 'lane')?.native.messages).toEqual([
    { id: 'text', text: 'Checking' }
  ])
  expect(projection.project('account', 'lane')?.native.tools).toHaveLength(1)
  apply(
    row(
      'text',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Checking sources' }] },
      'turn',
      2
    ),
    row(
      'tool',
      {
        kind: 'tool-call',
        name: 'web_search',
        callId: 'call',
        input: { query: 'Orca' },
        state: 'completed',
        durationMs: 1200
      },
      'turn',
      2
    )
  )
  apply(
    row(
      'tool',
      { kind: 'tool-call', name: 'web_search', callId: 'call', input: {}, state: 'running' },
      'turn',
      1
    )
  )
  const projected = projection.project('account', 'lane')!
  expect(projected.original).toBe('om_one')
  expect(projected.native.messages).toEqual([{ id: 'text', text: 'Checking sources' }])
  expect(projected.native.tools).toMatchObject([
    { id: 'call', status: 'success', durationMs: 1200 }
  ])
  apply(
    row(
      'question',
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Choose\n- Yes\n- No' }]
      },
      'turn'
    )
  )
  apply(
    row(
      'question',
      {
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Choose\n- Yes\n- No' },
          {
            type: 'tool-call',
            name: 'request_user_input_async',
            callId: 'ask',
            input: { questions: [{ title: 'Choose', options: ['Yes', 'No'] }] }
          }
        ]
      },
      'turn',
      1
    )
  )
  expect(projection.project('account', 'lane')?.native.messages).toEqual([
    { id: 'text', text: 'Checking sources' },
    { id: 'question', text: '' }
  ])
  const followup = (deliveryId: string, externalId = 'lane'): AgentJournalRenderItem['body'] => ({
    kind: 'message',
    role: 'user',
    blocks: [],
    connectorDelivery: {
      account: 'account',
      conversation: { source: 'feishu-local', externalId },
      deliveryId
    }
  })
  apply(row('queued', followup('om_queued')))
  expect(projection.project('account', 'lane')?.continuations).toEqual([])
  apply(
    row('queued', followup('om_queued'), 'turn', 1),
    row('steered', followup('om_steered'), 'turn'),
    row('foreign', followup('om_foreign', 'other-lane'), 'turn'),
    row('old-steer', followup('om_old'), 'old-turn')
  )
  expect(projection.project('account', 'lane')?.continuations).toEqual(['om_queued', 'om_steered'])
  apply(
    row('other-user', {
      kind: 'message',
      role: 'user',
      blocks: [],
      connectorDelivery: {
        account: 'account',
        conversation: { source: 'feishu-local', externalId: 'lane' },
        deliveryId: 'om_two'
      }
    }),
    row('other-turn', {
      kind: 'turn',
      turnId: 'provider-two',
      state: 'running',
      userItemId: 'other-user'
    })
  )
  expect(projection.project('account', 'lane')?.native.tools).toEqual([])
  expect(projection.project('account', 'lane')?.native.messages).toEqual([])
  expect(projection.project('account', 'lane')?.continuations).toEqual([])
})
