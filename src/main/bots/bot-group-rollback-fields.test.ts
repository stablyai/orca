import { afterEach, describe, expect, it } from 'vitest'
import type { BotGroup, BotGroupMessage } from '../../shared/bots/bot-group'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { remoteRoomMailArrived, settleStoredRoomMail } from './bot-group-remote-answers'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'
import { releasedStore } from './bot-group-released-builds.test-fixture'

// What keeps a group's paired roster, remote answers and image refs through a rollback, and how a
// remote answer's mail finds its post without reading the group's rooms.

const ATLAS = {
  environmentId: 'env-s',
  botId: 'bot-0',
  chatSessionId: '55555555-5555-4555-8555-555555555555',
  computer: 'Build Box',
  joinedAfter: 0,
  name: 'Atlas',
  avatar: null,
  agent: 'claude' as const
}

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function groupsOn(orchestration: OrchestrationDb, store: BotGroupStore): BotGroupRuntime {
  const runtime = { getOrchestrationDb: () => orchestration }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: room mail reads only the store, the orchestration database and `changed`.
  return { store, runtime, changed: () => {} } as unknown as BotGroupRuntime
}

/** A group with Atlas from a paired computer, and a post that asked Atlas a question. */
function room(question = 'q-1') {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const { db } = orchestration
  const groups = groupsOn(orchestration, new BotGroupStore(db))
  const group: BotGroup = {
    id: 'group-1',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'group-crew',
    folderWorkspaceId: 'home-1',
    createdAt: 1,
    members: [],
    remoteMembers: [ATLAS],
    replyMode: { kind: 'mentions' }
  }
  groups.store.put(group)
  const conversation = orchestration.openHomePeerMailConversation({
    environmentId: ATLAS.environmentId,
    peerFingerprint: 'fp-s',
    localParty: botGroupRoomMailAddress(group.id),
    localPaneKey: null
  })
  const ask = (id: string, requestId: string) => {
    const message: Omit<BotGroupMessage, 'sequence'> = {
      id,
      groupId: group.id,
      author: { kind: 'owner' },
      text: '@Atlas status?',
      createdAt: 2,
      turns: [],
      remoteAsks: [{ ...ATLAS, requestId, state: 'sent' }]
    }
    groups.store.append(message)
    return message
  }
  /** What the relay leaves here: the bot's answer, threaded on the question's id. */
  const arrive = (requestId: string, answer: string) =>
    orchestration.insertPeerMailMessage({
      conversationId: conversation.conversation_id,
      remoteParty: 'orca_session_id:atlas',
      message: {
        id: `msg_${requestId}`,
        from: 'Atlas on Build Box',
        to: botGroupRoomMailAddress(group.id),
        subject: 'Re: question',
        body: answer,
        threadId: requestId,
        payload: JSON.stringify({ requestId, botAnswer: { answers: 'your question' } })
      }
    })
  const unread = () => orchestration.getUnreadMessages(botGroupRoomMailAddress(group.id))
  const reply = (id: string) => groups.store.message(id)?.remoteAsks?.[0].reply
  const count = () => db.prepare('SELECT count(*) AS n FROM bot_group_remote_asks').get()?.n
  const posted = ask('post-1', question)
  return { orchestration, db, groups, group, posted, ask, arrive, unread, reply, count }
}

describe('a rollback to a build that predates these fields', () => {
  it('keeps the roster, remote answers and image refs an older build writes back without', () => {
    const { db, groups, group, posted, arrive } = room()
    arrive('q-1', 'Green on main.')
    remoteRoomMailArrived(groups, group.id)
    const image = { path: '/attachments/a.png', name: 'a.png', bytes: 3 }
    db.prepare(
      `UPDATE bot_group_messages SET record = json_set(record, '$.images', json(?)) WHERE id = ?`
    ).run(JSON.stringify([image]), posted.id)
    const answered = groups.store.message(posted.id)!

    // What an older build's edit, new thread or turn update writes: its own schema's keys only.
    const strip = (record: unknown, ...keys: string[]) => {
      const kept = JSON.parse(String(record))
      for (const key of keys) {
        delete kept[key]
      }
      return JSON.stringify(kept)
    }
    const groupRecord = db.prepare('SELECT record FROM bot_groups WHERE id = ?').get(group.id)!
    db.prepare(
      'INSERT INTO bot_groups(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record'
    ).run(group.id, strip(groupRecord.record, 'remoteMembers'))
    const record = db.prepare('SELECT record FROM bot_group_messages WHERE id = ?').get(posted.id)!
    db.prepare('UPDATE bot_group_messages SET record = ? WHERE id = ?').run(
      strip(record.record, 'remoteAsks', 'images'),
      posted.id
    )

    expect(groups.store.get(group.id).remoteMembers).toEqual([ATLAS])
    expect(groups.store.message(posted.id)).toEqual(answered)
    expect(answered.images).toEqual([image])
    expect(answered.remoteAsks![0].reply).toEqual({ kind: 'answer', text: 'Green on main.' })
  })

  it('still clears a roster removed on a build that knows it', () => {
    const { groups, group } = room()
    groups.store.put({ ...group, remoteMembers: undefined })
    expect(groups.store.get(group.id).remoteMembers).toBeUndefined()
  })
})

describe('a remote answer arriving', () => {
  it('joins the post it answers and settles its mail', () => {
    const { groups, group, arrive, unread, reply } = room()
    arrive('q-1', 'Green on main.')
    remoteRoomMailArrived(groups, group.id)
    expect(reply('post-1')).toEqual({ kind: 'answer', text: 'Green on main.' })
    expect(unread()).toEqual([])
  })

  it('indexes questions asked before the index existed, past damaged posts', () => {
    const { db, orchestration, group, arrive, reply } = room()
    db.prepare('INSERT INTO bot_group_messages(id, group_id, record) VALUES (?, ?, ?)').run(
      'damaged',
      'other-group',
      JSON.stringify({ remoteAsks: ['str', 7, null] })
    )
    db.exec('DROP TABLE bot_group_remote_asks; DROP TABLE bot_group_remote_asks_scanned')
    const groups = groupsOn(orchestration, new BotGroupStore(db))
    arrive('q-1', 'Green on main.')
    remoteRoomMailArrived(groups, group.id)
    expect(reply('post-1')).toEqual({ kind: 'answer', text: 'Green on main.' })
  })

  it('reads at startup only the posts added since the last pass', () => {
    const { db, groups } = room()
    new BotGroupStore(db)
    db.exec('DELETE FROM bot_group_remote_asks')
    new BotGroupStore(db)
    expect(groups.store.remoteAskMessage('q-1')).toBeNull()
  })

  it('places at startup an answer that came while a build that skips the index ran', () => {
    const { db, orchestration, arrive, unread, reply } = room()
    db.exec('DELETE FROM bot_group_remote_asks')
    db.prepare('UPDATE bot_group_remote_asks_scanned SET sequence = 0').run()
    arrive('q-1', 'Green on main.')
    settleStoredRoomMail(groupsOn(orchestration, new BotGroupStore(db)))
    expect(reply('post-1')).toEqual({ kind: 'answer', text: 'Green on main.' })
    expect(unread()).toEqual([])
  })

  it('settles mail no post takes, and a deleted group’s mail without lookups', () => {
    const { groups, group, arrive, unread, reply } = room()
    arrive('question-from-elsewhere', 'Not yours.')
    remoteRoomMailArrived(groups, group.id)
    expect(unread()).toEqual([])
    arrive('q-1', 'Green on main.')
    groups.store.deleteGroup(group.id)
    remoteRoomMailArrived(groups, group.id)
    expect(unread()).toEqual([])
    expect(reply('post-1')).toBeUndefined()
  })

  it('places the other answers when one post is damaged', () => {
    const { db, groups, group, ask, arrive, unread, reply } = room()
    ask('post-2', 'q-2')
    db.prepare(
      "UPDATE bot_group_messages SET record = json_set(record, '$.turns', 'x') WHERE id = ?"
    ).run('post-1')
    arrive('q-1', 'One.')
    arrive('q-2', 'Two.')
    remoteRoomMailArrived(groups, group.id)
    expect(reply('post-2')).toEqual({ kind: 'answer', text: 'Two.' })
    expect(unread()).toEqual([])
  })

  it('keeps mail unread when its post could not be written, for the next arrival', () => {
    const { db, groups, group, arrive, unread, reply } = room()
    db.exec(`CREATE TRIGGER reject_post BEFORE UPDATE ON bot_group_messages
      BEGIN SELECT RAISE(ABORT, 'busy'); END;`)
    arrive('q-1', 'Green on main.')
    remoteRoomMailArrived(groups, group.id)
    expect(unread()).toHaveLength(1)
    db.exec('DROP TRIGGER reject_post')
    remoteRoomMailArrived(groups, group.id)
    expect(reply('post-1')).toEqual({ kind: 'answer', text: 'Green on main.' })
    expect(unread()).toEqual([])
  })

  it('keeps unplaced mail for the next start when this one could not index', () => {
    const { db, orchestration, arrive, unread, reply } = room()
    db.exec('DELETE FROM bot_group_remote_asks')
    db.prepare('UPDATE bot_group_remote_asks_scanned SET sequence = 0').run()
    arrive('q-1', 'Green on main.')
    db.exec(`CREATE TRIGGER fail_marker BEFORE INSERT ON bot_group_remote_asks_scanned
      BEGIN SELECT RAISE(ABORT, 'disk'); END;`)
    const failed = new BotGroupStore(db)
    expect(failed.remoteAsksIndexed).toBe(false)
    settleStoredRoomMail(groupsOn(orchestration, failed))
    expect(unread()).toHaveLength(1)
    db.exec('DROP TRIGGER fail_marker')
    settleStoredRoomMail(groupsOn(orchestration, new BotGroupStore(db)))
    expect(reply('post-1')).toEqual({ kind: 'answer', text: 'Green on main.' })
    expect(unread()).toEqual([])
  })

  it('drops the index rows of deleted posts, also those deleted before it did', () => {
    const { db, groups, ask, count } = room()
    db.exec('DROP TRIGGER bot_group_messages_drop_remote_asks')
    db.prepare('DELETE FROM bot_group_messages WHERE id = ?').run('post-1')
    expect(count()).toBe(1)
    new BotGroupStore(db)
    expect(count()).toBe(0)
    ask('post-2', 'q-2')
    db.prepare('DELETE FROM bot_group_messages WHERE id = ?').run('post-2')
    expect(groups.store.remoteAskMessage('q-2')).toBeNull()
    expect(count()).toBe(0)
  })
})

const NOVA = {
  ...ATLAS,
  botId: 'bot-1',
  chatSessionId: '66666666-6666-4666-8666-666666666666',
  name: 'Nova'
}
const PIP = { ...NOVA, botId: 'bot-2', name: 'Pip' }

/** A member's line that answered a peer request, handed off, and failed with a coded error. */
function memberLine(groups: BotGroupRuntime, groupId: string, id = 'line-1'): BotGroupMessage {
  return groups.store.append({
    id,
    groupId,
    author: { kind: 'bot', id: 'bot-local', name: 'Juno' },
    text: '',
    createdAt: 3,
    handoffs: 2,
    mentioned: true,
    pausedAfter: 4,
    fromItems: true,
    turns: [
      {
        operationId: `op-${id}`,
        botId: 'bot-local',
        botName: 'Juno',
        avatar: null,
        avatarOutfit: 'top-hat',
        agent: 'claude',
        sessionId: 'session-juno',
        reply: 'Handing to Atlas.',
        answer: '42',
        handedOff: ['Atlas'],
        mailed: ['Nova'],
        error: 'Rate limited.',
        failure: { code: 'rate-limited' }
      }
    ]
  })
}

const raw = (db: BotGroupStore['db'], table: string, id: string) =>
  JSON.parse(String(db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id)!.record))

describe('a released build rewriting records it only partly knows', () => {
  it('keeps peer answers and hand-off marks through v1.4.268 retiring a member', () => {
    const { db, groups, group } = room()
    const line = memberLine(groups, group.id)
    const old = releasedStore(db, 'v1.4.268')
    old.put({ ...old.group(group.id), members: [] })
    const read = old.message(line.id)
    old.update({
      ...read,
      turns: read.turns.map((turn) => ({ ...turn, revoked: true, frozenItems: [] }))
    })

    const upgraded = new BotGroupStore(db)
    const { sequence: _sequence, ...kept } = upgraded.message(line.id)!
    const { sequence: _before, ...before } = line
    expect(kept).toEqual({
      ...before,
      turns: [{ ...before.turns[0], revoked: true, frozenItems: [] }]
    })
    expect(upgraded.get(group.id).remoteMembers).toEqual([ATLAS])
  })

  it('keeps outfits and failure codes through v1.4.271 renaming and settling, unless the error changed', () => {
    const { db, groups, group, posted } = room()
    groups.store.put({ ...group, remoteMembers: [{ ...ATLAS, avatarOutfit: 'beret' }] })
    groups.store.update({
      ...groups.store.message(posted.id)!,
      remoteAsks: [
        {
          ...posted.remoteAsks![0],
          avatarOutfit: 'beret',
          error: 'Offline.',
          failure: { code: 'offline' }
        }
      ]
    })
    const line = memberLine(groups, group.id)
    const old = releasedStore(db, 'v1.4.271')
    old.put({ ...old.group(group.id), name: 'Renamed' })
    old.update({ ...old.message(posted.id), text: 'edited' })
    const read = old.message(line.id)
    old.update({ ...read, turns: [{ ...read.turns[0], error: 'Another error.' }] })

    const upgraded = new BotGroupStore(db)
    expect(upgraded.get(group.id).remoteMembers).toEqual([{ ...ATLAS, avatarOutfit: 'beret' }])
    expect(upgraded.message(posted.id)!.remoteAsks![0]).toMatchObject({
      avatarOutfit: 'beret',
      failure: { code: 'offline' }
    })
    const turn = upgraded.message(line.id)!.turns[0]
    expect(turn).toMatchObject({ avatarOutfit: 'top-hat', answer: '42', error: 'Another error.' })
    expect(turn.failure).toBeUndefined()
    expect(upgraded.message(line.id)!.fromItems).toBe(true)
  })

  it('keeps a paired roster v1.4.271 could not read through its rename', () => {
    const { db, groups, group } = room()
    const helper = { ...NOVA, agent: 'codebuddy' as const }
    groups.store.put({ ...group, remoteMembers: [ATLAS, helper] })
    const old = releasedStore(db, 'v1.4.271')
    expect(old.group(group.id).remoteMembers).toBeUndefined()
    old.put({ ...old.group(group.id), name: 'Renamed' })
    expect(new BotGroupStore(db).get(group.id)).toMatchObject({
      name: 'Renamed',
      remoteMembers: [ATLAS, helper]
    })
  })

  it('repairs only the posts read or rewritten, and a rewrite here stores what v1.4.268 dropped', () => {
    const { db, groups, group } = room()
    const ids = ['line-1', 'line-2', 'line-3']
    for (const id of ids) {
      memberLine(groups, group.id, id)
    }
    // A retirement rewrites every post the member took part in.
    const old = releasedStore(db, 'v1.4.268')
    for (const id of ids) {
      const read = old.message(id)
      old.update({ ...read, turns: read.turns.map((turn) => ({ ...turn, revoked: true })) })
    }
    const saved = () => db.prepare('SELECT count(*) AS n FROM bot_group_dropped').get()?.n
    expect(saved()).toBe(3)
    const upgraded = new BotGroupStore(db)
    expect(saved()).toBe(3)
    expect(upgraded.message('line-2')!.turns[0]).toMatchObject({ revoked: true, answer: '42' })
    upgraded.update({ ...upgraded.message('line-3')!, text: 'edited' })
    expect(saved()).toBe(2)
    expect(raw(db, 'bot_group_messages', 'line-3').turns[0]).toMatchObject({
      revoked: true,
      answer: '42'
    })
  })

  it('keeps removed a member v1.4.271 added back and then removed, beside the ones it never saw', () => {
    const { db, group } = room()
    const helper = { ...NOVA, agent: 'codebuddy' as const }
    new BotGroupStore(db).put({ ...group, remoteMembers: [ATLAS, helper] })
    const old = releasedStore(db, 'v1.4.271')
    old.put({ ...old.group(group.id), remoteMembers: [ATLAS] })
    old.put({ ...old.group(group.id), remoteMembers: [] })
    expect(new BotGroupStore(db).get(group.id).remoteMembers).toEqual([helper])
  })

  it('still clears a paired roster v1.4.271 emptied', () => {
    const { db, group } = room()
    const old = releasedStore(db, 'v1.4.271')
    old.put({ ...old.group(group.id), remoteMembers: undefined })
    expect(new BotGroupStore(db).get(group.id).remoteMembers).toBeUndefined()
  })
})

describe('this build editing records a newer build wrote', () => {
  it('keeps the newer keys on entries it did not change', () => {
    const { db, groups, group, posted } = room()
    groups.store.put({ ...group, remoteMembers: [ATLAS, NOVA] })
    groups.store.append({
      ...posted,
      id: 'post-2',
      images: [{ path: '/attachments/a.png', name: 'a.png', bytes: 3 }],
      remoteAsks: [
        { ...posted.remoteAsks![0], reply: { kind: 'answer', text: 'Yes.' } },
        { ...NOVA, requestId: 'q-2', state: 'sending' }
      ]
    })
    db.prepare(
      `UPDATE bot_groups SET record = json_set(record, '$.remoteMembers[0].badge', 'gold', '$.pinned', json('true')) WHERE id = ?`
    ).run(group.id)
    db.prepare(
      `UPDATE bot_group_messages SET record = json_set(record, '$.remoteAsks[0].seenAt', 9, '$.remoteAsks[0].reply.lang', 'en',
        '$.images[0].width', 640, '$.pinned', json('true')) WHERE id = ?`
    ).run('post-2')

    groups.store.put({
      ...groups.store.get(group.id),
      remoteMembers: [ATLAS, { ...NOVA, name: 'Nova Two' }]
    })
    const post = groups.store.message('post-2')!
    groups.store.update({
      ...post,
      remoteAsks: [post.remoteAsks![0], { ...post.remoteAsks![1], state: 'sent' }]
    })

    const storedGroup = raw(db, 'bot_groups', group.id)
    expect(
      storedGroup.remoteMembers.map((member: { badge?: string; name: string }) => [
        member.name,
        member.badge
      ])
    ).toEqual([
      ['Atlas', 'gold'],
      ['Nova Two', undefined]
    ])
    expect(storedGroup.pinned).toBe(true)
    const storedPost = raw(db, 'bot_group_messages', 'post-2')
    expect(
      storedPost.remoteAsks.map((ask: { seenAt?: number; state: string }) => [
        ask.state,
        ask.seenAt
      ])
    ).toEqual([
      ['sent', 9],
      ['sent', undefined]
    ])
    expect([storedPost.remoteAsks[0].reply.lang, storedPost.images[0].width]).toEqual(['en', 640])
    expect(storedPost.pinned).toBe(true)
  })

  it('keeps a paired roster it can’t read, and adds to it', () => {
    const { db, groups, group } = room()
    groups.store.put({ ...group, remoteMembers: [ATLAS, NOVA] })
    db.prepare(
      `UPDATE bot_groups SET record = json_set(record, '$.remoteMembers[1].agent', 'future-agent') WHERE id = ?`
    ).run(group.id)
    expect(groups.store.get(group.id).remoteMembers).toBeUndefined()
    groups.store.put({ ...groups.store.get(group.id), remoteMembers: [PIP] })
    const names = raw(db, 'bot_groups', group.id).remoteMembers.map(
      (member: { name: string }) => member.name
    )
    expect(names).toEqual(['Atlas', 'Nova', 'Pip'])
  })

  it('leaves removed what it removes', () => {
    const { groups, group, posted } = room()
    const line = memberLine(groups, group.id)
    groups.store.retarget(line.id, 'op-2')
    const turn = groups.store.message(line.id)!.turns[0]
    expect(turn.operationId).toBe('op-2')
    expect([turn.error, turn.failure]).toEqual([undefined, undefined])
    // A list this build clears is written empty; left out, the stored one stays.
    groups.store.update({ ...groups.store.message(posted.id)!, remoteAsks: [] })
    expect(groups.store.message(posted.id)!.remoteAsks).toEqual([])
  })

  it('drops the spare session a legacy group moved off when it gets a home', () => {
    const { db, groups, group } = room()
    db.prepare(
      `UPDATE bot_groups SET record = json_set(record, '$.anchorSessionId', 'spare') WHERE id = ?`
    ).run(group.id)
    groups.store.put(groups.store.get(group.id))
    expect(raw(db, 'bot_groups', group.id).anchorSessionId).toBeUndefined()
  })
})

/** Another group's post under the id a deleted group's question post had. */
const REUSED_POST = {
  id: 'post-1',
  groupId: 'group-2',
  author: { kind: 'owner' as const },
  text: 'hi',
  createdAt: 5,
  turns: []
}

describe('the question index after an older build', () => {
  it('drops the rows of a group v1.4.268 deleted, so a reused post id names no question', () => {
    const { db, groups, group } = room()
    const old = releasedStore(db, 'v1.4.268')
    old.update(old.message('post-1'))
    old.deleteGroup(group.id)
    old.append(REUSED_POST)
    expect(groups.store.remoteAskMessage('q-1')).toBeNull()
    // Nor does the reused id get back what the deleted post's rewrite dropped.
    expect(new BotGroupStore(db).message('post-1')!.remoteAsks).toBeUndefined()
  })

  it('names no post that no longer holds the question, from rows left before the drop trigger', () => {
    const { db, orchestration, group } = room()
    db.exec('DROP TRIGGER bot_group_messages_drop_remote_asks')
    const old = releasedStore(db, 'v1.4.268')
    old.deleteGroup(group.id)
    old.append({
      id: 'post-1',
      groupId: 'group-2',
      author: { kind: 'owner' },
      text: 'hi',
      createdAt: 5,
      turns: []
    })
    const reopened = groupsOn(orchestration, new BotGroupStore(db))
    expect(reopened.store.remoteAskMessage('q-1')).toBeNull()
  })

  it('opens past a damaged question beside a good one, and indexes the good one', () => {
    const { db, posted } = room()
    db.prepare(
      `UPDATE bot_group_messages SET record = json_set(record, '$.remoteAsks', json_array('damaged', json(record -> '$.remoteAsks[0]'))) WHERE id = ?`
    ).run(posted.id)
    db.exec('DROP TABLE bot_group_remote_asks; DROP TABLE bot_group_remote_asks_scanned')
    const reopened = new BotGroupStore(db)
    expect(reopened.remoteAsksIndexed).toBe(true)
    const row = db.prepare('SELECT message_id FROM bot_group_remote_asks WHERE request_id = ?')
    expect(row.get('q-1')?.message_id).toBe(posted.id)
  })

  it('places an answer for a post a build without the index added, far back in the room', () => {
    const { db, orchestration, group, posted, arrive, unread } = room()
    const old = releasedStore(db, 'v1.4.268')
    old.append({
      ...posted,
      id: 'post-2',
      remoteAsks: [{ ...ATLAS, requestId: 'q-2', state: 'sent' }]
    })
    for (let index = 0; index < 45; index++) {
      old.append({ ...posted, id: `later-${index}`, remoteAsks: undefined })
    }
    const groups = groupsOn(orchestration, new BotGroupStore(db))
    arrive('q-2', 'Two.')
    remoteRoomMailArrived(groups, group.id)
    expect(groups.store.message('post-2')!.remoteAsks![0].reply).toEqual({
      kind: 'answer',
      text: 'Two.'
    })
    expect(unread()).toEqual([])
  })
})
