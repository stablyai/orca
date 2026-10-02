import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'
import { deferPausedDelivery } from './delivery-selection'
import { claimRoomBroadcastForTest } from './delivery-test-claim'

describe('paused claimed room delivery', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  const setup = () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const participant = database.participants.add({
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
        targetParticipantIds: [participant.id]
      })
    return { database, snapshot, participant, create }
  }

  it('returns a claimed retry to the queue head until its participant is active', () => {
    const { database, participant, create } = setup()
    const first = create('first').deliveries[0]
    claimRoomBroadcastForTest(database, first.messageId)
    database.messages.deliveries.complete(first.id, 'pending', 'send_failed')
    const claimed = database.messages.deliveries.claim(first.id)!
    const second = create('second').deliveries[0]

    expect(deferPausedDelivery(database, claimed)).toBeNull()
    database.participants.update(participant.id, { participation: 'paused' })
    expect(deferPausedDelivery(database, claimed)).toMatchObject({
      state: 'pending',
      intent: 'next',
      attempts: 2,
      error: 'room_participant_paused',
      attemptHistory: expect.arrayContaining([
        expect.objectContaining({ attempt: 2, error: 'room_participant_paused' })
      ])
    })
    expect(database.messages.deliveries.get(first.id).queuePosition).toBeLessThan(
      database.messages.deliveries.get(second.id).queuePosition!
    )
    expect(database.messages.deliveries.listDue()).toEqual([])

    database.participants.update(participant.id, { participation: 'active' })
    expect(database.messages.deliveries.listDue()[0]?.id).toBe(first.id)
    expect(database.messages.deliveries.claim(first.id)).toMatchObject({
      state: 'delivering',
      attempts: 3
    })
  })

  it('does not overwrite a stopped claim', () => {
    const { database, snapshot, participant, create } = setup()
    const delivery = create('claimed').deliveries[0]
    const claimed = claimRoomBroadcastForTest(database, delivery.messageId)![0]
    database.participants.update(participant.id, { participation: 'paused' })
    database.transaction(() => database.messages.deliveries.stopRoom(snapshot.room.id))

    expect(() => deferPausedDelivery(database, claimed)).toThrow('room_delivery_stopped')
    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_stopping'
    })
  })
})
