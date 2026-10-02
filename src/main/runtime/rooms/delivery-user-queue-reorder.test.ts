import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'

describe('room user queue reorder', () => {
  let db: RoomDatabase | undefined
  afterEach(() => db?.close())

  it('reorders user work without exposing interleaved agent deliveries', () => {
    db = new RoomDatabase(':memory:')
    const snapshot = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const codex = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    const claude = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const createUser = (body: string) =>
      db!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds: [codex.id]
      })
    const first = createUser('first')
    const internal = db.messages.create({
      roomId: snapshot.room.id,
      senderId: claude.id,
      senderIdentity: claude.identity,
      actorKind: 'agent',
      body: 'internal',
      targetParticipantIds: [codex.id]
    })
    const second = createUser('second')
    const internalPosition = internal.deliveries[0].queuePosition

    db.messages.deliveries.reorder(
      codex.id,
      [second.deliveries[0].id, first.deliveries[0].id],
      second.deliveries[0].id
    )

    expect(db.messages.deliveries.get(internal.deliveries[0].id).queuePosition).toBe(
      internalPosition
    )
    expect(db.messages.deliveries.get(second.deliveries[0].id).queuePosition).toBeLessThan(
      db.messages.deliveries.get(first.deliveries[0].id).queuePosition!
    )
  })

  it('reorders the shared user queue without moving hidden agent deliveries', () => {
    db = new RoomDatabase(':memory:')
    const snapshot = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const codex = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    const claude = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const createUser = (body: string) =>
      db!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body
      })
    const first = createUser('first')
    const internal = db.messages.create({
      roomId: snapshot.room.id,
      senderId: claude.id,
      senderIdentity: claude.identity,
      actorKind: 'agent',
      body: 'internal',
      targetParticipantIds: [codex.id]
    })
    const second = createUser('second')
    const internalPosition = internal.deliveries[0].queuePosition

    db.messages.deliveries.reorderAll(
      snapshot.room.id,
      [second.message.id, first.message.id],
      second.message.id
    )

    expect(db.messages.deliveries.get(internal.deliveries[0].id).queuePosition).toBe(
      internalPosition
    )
    for (const participant of [codex, claude]) {
      const position = (messageId: string) =>
        db!.messages.deliveries
          .listForMessage(messageId)
          .find((delivery) => delivery.participantId === participant.id)!.queuePosition!
      expect(position(second.message.id)).toBeLessThan(position(first.message.id))
    }
  })
})
