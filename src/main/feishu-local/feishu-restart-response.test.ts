import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { FeishuNativeProjection } from './feishu-native-projection'
import { cardData } from './feishu-card-data'

it('routes a native restart claim back to its saved response without trusting text or another lane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-restart-'))
  let store = new FeishuInbox(join(dir, 'db'))
  try {
    const { account } = store.add('scope', 'bot', {
      name: 'profile',
      appId: 'app',
      brand: 'feishu'
    })
    const id = store.updateResponse(account, 'lane', 'original', 'chat', { kind: 'begin' })!
    store.updateResponse(account, 'lane', 'original', 'chat', {
      kind: 'final',
      text: 'Interrupted',
      failed: true
    })
    store.postedCard(account, id, 2, 'same-message')
    const newer = store.updateResponse(account, 'lane', 'newer', 'chat', { kind: 'begin' })!
    const before = store.getCard(account, newer)
    store.close()
    store = new FeishuInbox(join(dir, 'db'))
    const projection = new FeishuNativeProjection()
    projection.apply({
      type: 'batch',
      sessionId: 'session',
      batch: {
        cursor: { epoch: 'e', sequence: 3 },
        removedItemIds: [],
        submissions: [],
        items: [
          {
            itemId: 'resume',
            revision: 1,
            sequence: 1,
            observedAt: 10,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'original' }],
              connectorClaim: {
                cutTurnId: 'cut',
                cutKind: 'restart',
                origin: [
                  {
                    account: account,
                    conversation: { source: 'feishu-local', externalId: 'lane' },
                    deliveryId: 'original'
                  }
                ]
              }
            }
          },
          {
            itemId: 'turn',
            revision: 1,
            sequence: 2,
            observedAt: 11,
            body: {
              kind: 'turn',
              turnId: 'turn',
              userItemId: 'resume',
              state: 'completed',
              startedAt: 11,
              completedAt: 20,
              outcome: 'success'
            }
          },
          {
            itemId: 'answer',
            revision: 1,
            sequence: 3,
            observedAt: 19,
            turnScope: { kind: 'turn', turnItemId: 'turn' },
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Recovered result' }]
            }
          }
        ]
      }
    })
    expect(projection.project('other-account', 'lane')).toBeNull()
    expect(projection.project(account, 'other-lane')).toBeNull()
    const value = projection.project(account, 'lane')!
    expect(value.original).toBe('original')
    store.updateResponse(account, 'lane', value.original, 'chat', {
      kind: 'native',
      value: value.native
    })
    const recovered = store.getCard(account, id)!
    expect(recovered.message).toBe('same-message')
    expect(cardData.parse(JSON.parse(recovered.body)).response?.final).toBe('Recovered result')
    expect(store.getCard(account, newer)).toEqual(before)
    const opener = projection.items.get('resume')!
    if (opener.body.kind === 'message') {
      delete opener.body.connectorClaim
    }
    expect(projection.project(account, 'lane')).toBeNull()
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
