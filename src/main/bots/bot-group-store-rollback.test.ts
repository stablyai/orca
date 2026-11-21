import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  BotGroupMessageSchema,
  BotGroupSchema,
  type BotGroup,
  type BotGroupMessage,
  type BotGroupRemoteMember
} from '../../shared/bots/bot-group-schema'
import SyncDatabase from '../sqlite/sync-database'
import { BotGroupStore } from './bot-group-store'

// The records as the build before paired-computer members and peer answers reads them: its
// schemas lack those fields, so its parse strips them and its next write drops them.
const OldTurn = BotGroupMessageSchema.shape.turns.element.omit({ answer: true })
const OldGroup = BotGroupSchema.omit({ remoteMembers: true })
const OldMessage = BotGroupMessageSchema.omit({ sequence: true, remoteAsks: true }).extend({
  turns: z.array(OldTurn)
})

const databases: SyncDatabase[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function open(): { db: SyncDatabase; store: BotGroupStore } {
  const db = new SyncDatabase(':memory:')
  databases.push(db)
  return { db, store: new BotGroupStore(db) }
}

/** The older build's store: reads with its own schema and writes the whole record back. */
function olderBuild(db: SyncDatabase) {
  const record = (table: string, id: string): unknown => {
    const row = db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id)
    return JSON.parse(String(row?.record))
  }
  return {
    get: (id: string) => OldGroup.parse(record('bot_groups', id)),
    put: (group: z.infer<typeof OldGroup>) =>
      db
        .prepare('UPDATE bot_groups SET record = ? WHERE id = ?')
        .run(JSON.stringify(group), group.id),
    message: (id: string) => OldMessage.parse(record('bot_group_messages', id)),
    update: (message: z.infer<typeof OldMessage>) =>
      db
        .prepare('UPDATE bot_group_messages SET record = ? WHERE id = ?')
        .run(JSON.stringify(message), message.id)
  }
}

const ATLAS: BotGroupRemoteMember = {
  environmentId: 'env-s',
  botId: 'bot-atlas',
  chatSessionId: 'chat-atlas',
  computer: 'Build Box',
  joinedAfter: 0,
  name: 'Atlas',
  avatar: null,
  agent: 'claude'
}

const GROUP: BotGroup = {
  id: 'group-1',
  name: 'Crew',
  hostId: 'local',
  revision: 1,
  folder: 'crew',
  folderWorkspaceId: 'workspace-1',
  createdAt: 1,
  members: [
    { botId: 'bot-scout', sessionId: 'session-scout' },
    { botId: 'bot-forge', sessionId: 'session-forge' }
  ],
  remoteMembers: [ATLAS],
  replyMode: { kind: 'bot', botId: 'bot-scout' }
}

const turn = (botId: string, operationId: string) => ({
  operationId,
  botId,
  botName: botId,
  avatar: null,
  agent: 'claude' as const,
  sessionId: `session-${botId.slice(4)}`
})

const POST: Omit<BotGroupMessage, 'sequence'> = {
  id: 'post-1',
  groupId: GROUP.id,
  author: { kind: 'owner' },
  text: '@Atlas @Forge status?',
  createdAt: 2,
  turns: [
    { ...turn('bot-scout', 'op-scout'), reply: 'Asked Forge.' },
    { ...turn('bot-forge', 'op-forge'), reply: 'Done.', answer: 'Green on main.' }
  ],
  remoteAsks: [
    {
      ...ATLAS,
      requestId: 'ask-atlas',
      state: 'sent',
      reply: { kind: 'answer', text: 'Deployed.' }
    }
  ]
}

function seeded() {
  const opened = open()
  opened.store.put(GROUP)
  opened.store.append(POST)
  return { ...opened, old: olderBuild(opened.db) }
}

describe('a group written back by an older build', () => {
  it('keeps its paired-computer members when the older build starts a new thread', () => {
    const { store, old } = seeded()
    const before = old.get(GROUP.id)
    old.put({
      ...before,
      threads: [{ id: 'thread-1', createdAt: 3, members: before.members }]
    })

    const group = store.get(GROUP.id)
    expect(group.threads?.map((thread) => thread.id)).toEqual(['thread-1'])
    expect(group.remoteMembers).toEqual([ATLAS])
    expect(store.list()[0].remoteMembers).toEqual([ATLAS])
  })

  it('keeps the roster, remote answers and peer answers through a rename and a member leaving', () => {
    const { store, old } = seeded()
    const renamed = old.get(GROUP.id)
    old.put({ ...renamed, name: 'Crew 2', revision: 2 })
    // Its member removal: Scout leaves, and its turns freeze on the posts it rewrites.
    const left = old.get(GROUP.id)
    old.put({ ...left, revision: 3, members: left.members.slice(1) })
    const post = old.message(POST.id)
    old.update({
      ...post,
      turns: post.turns.map((entry) =>
        entry.botId === 'bot-scout' ? { ...entry, revoked: true, frozenItems: [] } : entry
      )
    })

    const group = store.get(GROUP.id)
    expect(group).toMatchObject({ name: 'Crew 2', revision: 3, remoteMembers: [ATLAS] })
    expect(group.members.map((member) => member.botId)).toEqual(['bot-forge'])
    const [message] = store.messages(GROUP.id)
    // The older build's own change stands; what it could not read comes back beside it.
    expect(message.turns[0]).toMatchObject({ operationId: 'op-scout', revoked: true })
    expect(message.turns[1]).toMatchObject({ operationId: 'op-forge', answer: 'Green on main.' })
    expect(message.remoteAsks).toEqual(POST.remoteAsks)
    expect(store.message(POST.id)?.remoteAsks?.[0].requestId).toBe('ask-atlas')
    expect(store.roomMessages(GROUP.id, undefined)[0].turns[1].answer).toBe('Green on main.')
  })

  it('still lets this build drop its paired-computer members and remote answers', () => {
    const { store, db } = seeded()
    store.put({ ...store.get(GROUP.id), remoteMembers: undefined })
    const { remoteAsks: _asks, ...post } = store.messages(GROUP.id)[0]
    store.update({ ...post, turns: post.turns.map(({ answer: _answer, ...entry }) => entry) })

    expect(store.get(GROUP.id).remoteMembers).toBeUndefined()
    const [message] = store.messages(GROUP.id)
    expect(message.remoteAsks).toBeUndefined()
    expect(message.turns.map((entry) => entry.answer)).toEqual([undefined, undefined])
    store.deleteGroup(GROUP.id)
    store.put(GROUP)
    store.append(POST)
    store.deleteGroup(GROUP.id)
    for (const table of ['bot_group_extras', 'bot_group_message_extras']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  })
})

describe('a store an earlier build created', () => {
  it('reads and keeps the fields a build before this one saved inside the record', () => {
    const db = new SyncDatabase(':memory:')
    databases.push(db)
    new BotGroupStore(db)
    db.exec(`DROP TABLE IF EXISTS bot_group_extras; DROP TABLE IF EXISTS bot_group_message_extras;`)
    db.prepare('INSERT INTO bot_groups(id, record) VALUES (?, ?)').run(
      GROUP.id,
      JSON.stringify(GROUP)
    )
    db.prepare('INSERT INTO bot_group_messages(id, group_id, record) VALUES (?, ?, ?)').run(
      POST.id,
      GROUP.id,
      JSON.stringify(POST)
    )

    const store = new BotGroupStore(db)
    expect(store.get(GROUP.id).remoteMembers).toEqual([ATLAS])
    expect(store.messages(GROUP.id)[0]).toMatchObject({ remoteAsks: POST.remoteAsks })
    // This build's next writes move them beside the record, where an older build's write keeps them.
    store.put({ ...store.get(GROUP.id), name: 'Renamed' })
    store.update({ ...store.messages(GROUP.id)[0], text: 'edited' })
    const old = olderBuild(db)
    old.put(old.get(GROUP.id))
    old.update(old.message(POST.id))

    expect(store.get(GROUP.id)).toMatchObject({ name: 'Renamed', remoteMembers: [ATLAS] })
    expect(store.messages(GROUP.id)[0]).toMatchObject({
      text: 'edited',
      remoteAsks: POST.remoteAsks,
      turns: [{ operationId: 'op-scout' }, { operationId: 'op-forge', answer: 'Green on main.' }]
    })
  })

  it('opens a store with only local groups and writes nothing beside them', () => {
    const db = new SyncDatabase(':memory:')
    databases.push(db)
    db.exec(`CREATE TABLE bot_groups (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE bot_group_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, record TEXT NOT NULL);`)
    const { remoteMembers: _members, ...local } = GROUP
    db.prepare('INSERT INTO bot_groups(id, record) VALUES (?, ?)').run(
      local.id,
      JSON.stringify(local)
    )

    const store = new BotGroupStore(db)
    expect(store.get(GROUP.id)).toEqual(local)
    store.put({ ...store.get(GROUP.id), name: 'Renamed' })
    store.append({ ...POST, remoteAsks: undefined, turns: [turn('bot-scout', 'op-scout')] })
    expect(store.get(GROUP.id)).toEqual({ ...local, name: 'Renamed' })
    for (const table of ['bot_group_extras', 'bot_group_message_extras']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  })
})

describe('fields a newer build saved', () => {
  it('survive this build writing the group and the post back unchanged around them', () => {
    const { db, store } = seeded()
    const newer = {
      record: {
        remoteMembers: [{ ...ATLAS, pinned: true }],
        remoteAsks: [{ ...POST.remoteAsks![0], state: 'queued' }],
        mood: 'calm'
      },
      turns: { 'op-forge': { answer: 'Green on main.', cost: 3 } }
    }
    db.prepare('UPDATE bot_group_extras SET extras = ? WHERE group_id = ?').run(
      JSON.stringify({ record: { remoteMembers: newer.record.remoteMembers, mood: 'calm' } }),
      GROUP.id
    )
    db.prepare('UPDATE bot_group_message_extras SET extras = ? WHERE message_id = ?').run(
      JSON.stringify({
        record: { remoteAsks: newer.record.remoteAsks, mood: 'calm' },
        turns: newer.turns
      }),
      POST.id
    )

    const group = store.get(GROUP.id)
    expect(group.remoteMembers).toEqual([ATLAS])
    store.put({ ...group, threads: [{ id: 'thread-1', createdAt: 3, members: group.members }] })
    const [post] = store.messages(GROUP.id)
    // An ask state this build can't read drops the list, never the post.
    expect(post.remoteAsks).toBeUndefined()
    store.update({ ...post, text: 'edited' })

    const extras = (table: string, key: string, id: string): unknown =>
      JSON.parse(String(db.prepare(`SELECT extras FROM ${table} WHERE ${key} = ?`).get(id)?.extras))
    expect(extras('bot_group_extras', 'group_id', GROUP.id)).toEqual({
      record: { remoteMembers: newer.record.remoteMembers, mood: 'calm' }
    })
    expect(extras('bot_group_message_extras', 'message_id', POST.id)).toEqual({
      record: { remoteAsks: newer.record.remoteAsks, mood: 'calm' },
      turns: newer.turns
    })
    expect(store.messages(GROUP.id)[0].text).toBe('edited')
  })
})
