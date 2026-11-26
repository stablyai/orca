import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { FeishuNativeProjection } from './feishu-native-projection'
import { cardData } from './feishu-card-data'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'

it('returns proven worker reports to their durable response, not a newer request or another lane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-worker-'))
  const path = join(dir, 'db')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'app', brand: 'feishu' })
    const worker = {
      name: 'Worker',
      party: { address: 'worker:1', terminalHandle: null, orcaSessionId: null }
    }
    const p = new FeishuNativeProjection()
    let sequence = 0
    const row = (
      itemId: string,
      body: AgentJournalRenderItem['body'],
      turn?: string
    ): AgentJournalRenderItem => ({
      itemId,
      body,
      sequence: ++sequence,
      revision: 0,
      observedAt: sequence,
      turnScope: turn ? { kind: 'turn', turnItemId: turn } : { kind: 'thread' }
    })
    const apply = (...items: AgentJournalRenderItem[]) =>
      p.apply({
        type: 'batch',
        sessionId: 'parent',
        batch: {
          cursor: { epoch: 'e', sequence },
          items,
          removedItemIds: [],
          submissions: []
        }
      })
    apply(
      row('ask', {
        kind: 'message',
        role: 'user',
        blocks: [],
        connectorDelivery: {
          account: b.account,
          conversation: { source: 'feishu-local', externalId: 'lane' },
          deliveryId: 'original'
        }
      }),
      row('turn', {
        kind: 'turn',
        turnId: 'turn',
        state: 'completed',
        userItemId: 'ask',
        startedAt: 1,
        completedAt: 5
      }),
      row('start', { kind: 'agent-start', worker, dispatchId: 'dispatch', task: 'Read only' }),
      row(
        'started',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Worker started' }] },
        'turn'
      )
    )
    const first = p.project(b.account, 'lane')!
    const id = store.updateResponse(b.account, 'lane', first.original, 'chat', {
      kind: 'native',
      value: first.native
    })!
    store.updateResponse(b.account, 'lane', 'original', 'chat', {
      kind: 'final',
      text: 'Worker started'
    })
    store.postedCard(b.account, id, 2, 'same-feishu-message')
    const newer = store.updateResponse(b.account, 'lane', 'newer', 'chat', { kind: 'begin' })!
    const untouched = store.getCard(b.account, newer)
    store.close()
    store = new FeishuInbox(path)
    expect(store.workerResponse(b.account, 'lane', ['worker:1'])).toBe('original')
    expect(store.workerResponse('other-account', 'lane', ['worker:1'])).toBeNull()
    expect(store.workerResponse(b.account, 'other-lane', ['worker:1'])).toBeNull()
    expect(store.workerResponse(b.account, 'lane', ['unrecorded'])).toBeNull()
    const report = (trusted: boolean): AgentJournalRenderItem['body'] => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'worker_done' }],
      from: {
        kind: 'agent',
        senders: [
          { ...worker, relation: 'worker', ...(trusted ? { toConversation: true as const } : {}) }
        ],
        orchestration: { message: 'mail-notice', mailbox: 'run:1', dispatchId: null, messages: [] }
      }
    })
    apply(
      row('untrusted', report(false)),
      row('turn-u', {
        kind: 'turn',
        turnId: 'u',
        state: 'running',
        userItemId: 'untrusted',
        startedAt: 6
      })
    )
    expect(p.project(b.account, 'lane', 'original')).toBeNull()
    apply(
      row('report', report(true)),
      row('turn-r', {
        kind: 'turn',
        turnId: 'r',
        state: 'completed',
        userItemId: 'report',
        startedAt: 8,
        completedAt: 12
      }),
      row(
        'answer',
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Verified worker result' }]
        },
        'turn-r'
      )
    )
    const original = store.workerResponse(b.account, 'lane', p.reportWorkers()!)
    const result = p.project(b.account, 'lane', original)!
    store.updateResponse(b.account, 'lane', result.original, 'chat', {
      kind: 'native',
      value: result.native
    })
    const final = store.getCard(b.account, id)!
    expect(final.message).toBe('same-feishu-message')
    expect(cardData.parse(JSON.parse(final.body)).response?.final).toBe('Verified worker result')
    expect(store.getCard(b.account, newer)).toEqual(untouched)
    store.updateResponse(b.account, 'lane', 'original', 'chat', {
      kind: 'native',
      value: first.native
    })
    expect(store.getCard(b.account, id)).toEqual(final)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
