import { afterEach, describe, expect, it } from 'vitest'
import type { BotItemBotActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const OWNER: BotItemBotActor = { kind: 'bot', botId: 'owner', chatId: 'owner-chat' }
const HELPER: BotItemBotActor = { kind: 'bot', botId: 'helper', chatId: 'helper-chat' }

describe('attaching work to another agent’s item', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function itemNeedingYou(): { store: BotItemsStore; uid: string; question: number | null } {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    const { uid } = store.add(
      {
        ownerBotId: OWNER.botId,
        chatId: OWNER.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      OWNER
    )
    store.set(uid, { status: 'needs_you', comment: 'Which branch?' }, OWNER)
    return { store, uid, question: store.get(uid)!.questionEvent }
  }

  it('attaches the caller’s own worker, PR, URL and file and leaves Needs you and its question', () => {
    const { store, uid, question } = itemNeedingYou()
    const links = [
      { kind: 'dispatch', ref: 'ctx_helper' },
      { kind: 'pr', ref: 'acme/app#7' },
      { kind: 'url', ref: 'https://example.com/run' },
      { kind: 'file', ref: '/tmp/report.md' }
    ] as const
    store.link(uid, links, HELPER, { ctx_helper: HELPER.botId })
    expect(store.links(uid).map((link) => `${link.kind}:${link.ref}`)).toEqual(
      expect.arrayContaining([
        'dispatch:ctx_helper',
        'pr:acme/app#7',
        'url:https://example.com/run',
        'file:/tmp/report.md'
      ])
    )
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: question })
  })

  it('refuses linking a worker the caller did not start', () => {
    const { store, uid } = itemNeedingYou()
    const starters: Record<string, string>[] = [{ ctx_other: OWNER.botId }, {}]
    for (const startedBy of starters) {
      expect(() =>
        store.link(uid, [{ kind: 'dispatch', ref: 'ctx_other' }], HELPER, startedBy)
      ).toThrow(/link only workers you started/)
    }
    expect(store.links(uid)).toEqual([])
  })

  it('links a worker the caller started for the item without moving Needs you', () => {
    const { store, uid, question } = itemNeedingYou()
    expect(store.linkStartedWorker(uid, 'ctx_helper', HELPER)).not.toBeNull()
    expect(store.links(uid).map((link) => link.ref)).toEqual(['ctx_helper'])
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: question })
  })

  it('keeps every other write the owner’s', () => {
    const { store, uid } = itemNeedingYou()
    const writes = [
      () => store.set(uid, { status: 'working' }, HELPER),
      () => store.set(uid, { title: 'Mine now' }, HELPER),
      () => store.set(uid, { doneMeans: 'Merged' }, HELPER),
      () =>
        store.set(
          uid,
          {
            status: 'needs_you',
            ask: { questions: [{ prompt: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
          },
          HELPER
        ),
      () => store.close(uid, 'canceled', 'Not needed', HELPER),
      () => store.close(uid, 'done', undefined, HELPER)
    ]
    for (const write of writes) {
      expect(write).toThrow(/belongs to another bot/)
    }
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', title: 'Ship it', doneMeans: null })
  })

  it('still lets the owner link anyone’s worker, and its own worker start moves Needs you on', () => {
    const { store, uid } = itemNeedingYou()
    store.link(uid, [{ kind: 'dispatch', ref: 'ctx_helper' }], OWNER)
    expect(store.get(uid)?.status).toBe('needs_you')
    store.linkStartedWorker(uid, 'ctx_owner', OWNER)
    expect(store.get(uid)?.status).toBe('working')
  })
})
