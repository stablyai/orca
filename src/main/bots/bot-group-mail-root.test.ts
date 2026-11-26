import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import SyncDatabase from '../sqlite/sync-database'
import { narrowGroupMailBatch } from './bot-group-peer-requests'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

const SESSION = 'bot-group-member-scout'
const itemMail = (id: string) => ({ id, thread_id: null, from_handle: BOT_ITEM_MAIL_SENDER })

/** A room whose member Scout has item mail `queued` on a saved line, its turn not yet run. */
function room(queued: string) {
  const store = new BotGroupStore(new SyncDatabase(':memory:'))
  const group: BotGroup = {
    id: 'room-1',
    name: 'Release',
    hostId: 'local',
    revision: 1,
    folder: '/work/release',
    folderWorkspaceId: 'folder:release',
    createdAt: 0,
    members: [{ botId: 'bot-0', sessionId: SESSION }],
    replyMode: { kind: 'all' }
  }
  store.put(group)
  const line = store.append({
    id: `mail:${SESSION}:${queued}`,
    groupId: group.id,
    author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
    text: 'Scout read a change to its items: Ship notes',
    createdAt: 0,
    fromItems: true,
    turns: [
      {
        operationId: 'op-1',
        botId: 'bot-0',
        botName: 'Scout',
        avatar: null,
        agent: 'claude',
        sessionId: SESSION
      }
    ]
  })
  const stop = () =>
    store.put({
      ...group,
      members: [{ ...group.members[0]!, stoppedThroughSequence: line.sequence }]
    })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item mail's narrowing reads only the room store.
  const groups = { store } as unknown as BotGroupRuntime
  return { groups, stop }
}

describe("a room's Stop and item mail", () => {
  it('retires item mail queued before the Stop instead of redelivering it', () => {
    const { groups, stop } = room('msg_1')
    stop()
    expect(narrowGroupMailBatch(groups, SESSION, [itemMail('msg_1')])).toEqual({
      messages: [],
      ended: ['msg_1']
    })
  })

  it('still delivers item mail that arrives after the Stop', () => {
    const { groups, stop } = room('msg_1')
    stop()
    const later = itemMail('msg_12')
    expect(narrowGroupMailBatch(groups, SESSION, [later])).toEqual({ messages: [later], ended: [] })
  })
})
