import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'

describe('room broadcast queue placement', () => {
  let database: RoomDatabase | undefined
  afterEach(() => database?.close())

  it('atomically returns a directed message at the requested position', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = (['codex', 'claude'] as const).map((identity) =>
      database!.participants.add({
        roomId: snapshot.room.id,
        identity,
        displayName: identity,
        agent: identity
      })
    )
    const create = (body: string) =>
      database!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds: [participants[0]!.id]
      })
    const directed = create('directed')
    const first = create('first')
    const second = create('second')
    const targets = participants.map(({ id }) => id)
    database.messages.deliveries.retarget(first.message.id, targets)
    database.messages.deliveries.retarget(second.message.id, targets)

    const changed = database.messages.deliveries.reorderAll(
      snapshot.room.id,
      [first.message.id, directed.message.id, second.message.id],
      undefined,
      directed.message.id
    )
    const returned = database.messages.deliveries.listForMessage(directed.message.id)

    expect(returned).toEqual(
      expect.arrayContaining(
        targets.map((participantId) =>
          expect.objectContaining({ participantId, state: 'pending', attempts: 0 })
        )
      )
    )
    expect(changed.map(({ id }) => id)).toEqual(
      expect.arrayContaining(returned.map(({ id }) => id))
    )
    for (const participantId of targets) {
      const positions = [first, directed, second].map(
        ({ message }) =>
          database!.messages.deliveries
            .listForMessage(message.id)
            .find((delivery) => delivery.participantId === participantId)?.queuePosition
      )
      expect(positions).toEqual([...positions].sort((left, right) => left! - right!))
    }
  })
})
