import { afterEach, describe, expect, it } from 'vitest'
import type { BotGroup, BotGroupMessage } from '../../shared/bots/bot-group'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { remoteRoomMailArrived, settleStoredRoomMail } from './bot-group-remote-answers'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

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

  it('advances an existing cutoff through a later legacy write after upgrading old triggers', () => {
    const { db, groups, group, ask, posted } = room()
    const previousCutoff = groups.store.message(posted.id)!.sequence
    groups.store.put({ ...group, legacyRemoteCutoff: previousCutoff })
    const updated = ask('later', 'q-2')
    db.exec(`DROP TRIGGER IF EXISTS bot_groups_preserve_remote_cutoff;
      DROP TRIGGER IF EXISTS bot_groups_keep_legacyRemoteCutoff;
      DROP TRIGGER IF EXISTS bot_groups_fence_legacy_room_write;
      CREATE TRIGGER bot_groups_keep_legacyRemoteCutoff AFTER UPDATE OF record ON bot_groups
        WHEN json_type(NEW.record, '$.legacyRemoteCutoff') IS NULL
          AND json_type(OLD.record, '$.legacyRemoteCutoff') IS NOT NULL
        BEGIN
          UPDATE bot_groups SET record = json_set(record, '$.legacyRemoteCutoff',
            OLD.record -> '$.legacyRemoteCutoff') WHERE id = NEW.id;
        END;
      CREATE TRIGGER bot_groups_fence_legacy_room_write AFTER UPDATE OF record ON bot_groups
        WHEN json_type(NEW.record, '$.remoteStopWriter') IS NULL
          AND NEW.record ->> '$.revision' > OLD.record ->> '$.revision'
        BEGIN
          UPDATE bot_groups SET record = json_set(record, '$.legacyRemoteCutoff',
            (SELECT max(sequence) FROM bot_group_messages WHERE group_id = NEW.id))
            WHERE id = NEW.id;
        END;`)
    const readGroup = new BotGroupStore(db)
    db.prepare(
      `UPDATE bot_groups SET record = json_remove(json_set(record, '$.revision', 2),
        '$.remoteStopWriter', '$.legacyRemoteCutoff') WHERE id = ?`
    ).run(group.id)
    expect(readGroup.get(group.id).legacyRemoteCutoff).toBe(readGroup.message(updated.id)!.sequence)
  })

  it('keeps nested route pins when an old writer still knows the roster and question arrays', () => {
    const { db, groups, group, posted } = room()
    const [ask] = posted.remoteAsks!
    const pinned = { ...ATLAS, pairing: 'fp-s' }
    const pinnedAsk = {
      ...ask,
      pairing: 'fp-s',
      conversationId: 'peerconv_kept',
      interactive: true as const
    }
    groups.store.put({ ...group, remoteMembers: [pinned] })
    groups.store.update({ ...groups.store.message(posted.id)!, remoteAsks: [pinnedAsk] })
    db.prepare(
      `UPDATE bot_groups SET record = json_remove(record, '$.remoteMembers[0].pairing') WHERE id = ?`
    ).run(group.id)
    db.prepare(
      `UPDATE bot_group_messages SET record = json_remove(record,
        '$.remoteAsks[0].pairing', '$.remoteAsks[0].conversationId', '$.remoteAsks[0].interactive')
       WHERE id = ?`
    ).run(posted.id)
    expect(groups.store.get(group.id).remoteMembers).toEqual([pinned])
    expect(groups.store.message(posted.id)?.remoteAsks).toEqual([pinnedAsk])
    const replacement = { ...ATLAS, chatSessionId: '77777777-7777-4777-8777-777777777777' }
    groups.store.put({ ...group, remoteMembers: [replacement] })
    expect(groups.store.get(group.id).remoteMembers).toEqual([replacement])
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
