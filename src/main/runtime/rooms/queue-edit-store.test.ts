import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'

describe('room queue composer editing', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  it('reserves the edited row without corrupting the remaining queue', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    const create = (body: string) =>
      database!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds: [agent.id]
      })
    const first = create('first')
    const second = create('second')
    const third = create('third')
    const token = database.transaction(() => database!.queueEdits.begin(first.message.id))

    expect(database.messages.listQueued(snapshot.room.id).messages.map(({ id }) => id)).toEqual([
      second.message.id,
      third.message.id
    ])
    expect(database.messages.deliveries.listDue().map(({ messageId }) => messageId)).toEqual([
      second.message.id
    ])
    database.messages.deliveries.reorderAll(
      snapshot.room.id,
      [third.message.id, second.message.id],
      third.message.id
    )
    expect(() => database!.messages.deliveries.retarget(first.message.id, [agent.id])).toThrow(
      'room_delivery_queue_stale'
    )

    database.transaction(() =>
      database!.queueEdits.finish({
        messageId: first.message.id,
        editToken: token,
        body: 'first edited',
        mentions: [],
        retainedAttachmentIds: [],
        attachments: []
      })
    )
    expect(database.messages.get(first.message.id)).toMatchObject({
      body: 'first edited',
      editedAt: null,
      queueEditing: false
    })
    const unchanged = database.transaction(() => database!.queueEdits.begin(first.message.id))
    database.transaction(() =>
      database!.queueEdits.finish({
        messageId: first.message.id,
        editToken: unchanged,
        body: 'first edited',
        mentions: [],
        retainedAttachmentIds: [],
        attachments: []
      })
    )
    expect(database.messages.get(first.message.id).editedAt).toBeNull()
    expect(database.messages.deliveries.listDue()[0]?.messageId).toBe(first.message.id)
  })
})
