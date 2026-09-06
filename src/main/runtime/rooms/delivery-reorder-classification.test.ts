import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'
import { updateRoomParticipant } from './participant-participation'

describe('room delivery reorder classification', () => {
  let db: RoomDatabase | undefined

  afterEach(() => db?.close())

  it('rejects a stale participant reorder after directed becomes broadcast', () => {
    const setup = createRoom(3)
    db = setup.db
    const blocker = setup.create('blocker')
    const moved = setup.create(
      'moved',
      setup.agents.slice(0, 2).map(({ id }) => id)
    )
    const target = setup.agents[0]!
    const blockerDelivery = deliveryFor(db, blocker.message.id, target.id)
    const movedDelivery = deliveryFor(db, moved.message.id, target.id)
    updateRoomParticipant(
      db,
      setup.agents[2]!.id,
      { participation: 'paused' },
      () => undefined,
      () => undefined,
      () => undefined
    )
    const before = positions(db, [blockerDelivery.id, movedDelivery.id])

    expect(() =>
      db!.messages.deliveries.reorder(
        target.id,
        [movedDelivery.id, blockerDelivery.id],
        movedDelivery.id
      )
    ).toThrow('room_delivery_queue_stale')
    expect(positions(db, [blockerDelivery.id, movedDelivery.id])).toEqual(before)
  })

  it('rejects a stale shared reorder after broadcast becomes directed', () => {
    const setup = createRoom(2)
    db = setup.db
    const first = setup.create('first')
    const moved = setup.create('moved')
    setup.db.participants.add({
      roomId: setup.roomId,
      identity: 'late',
      displayName: 'Late',
      agent: 'codex'
    })
    const allIds = [...first.deliveries, ...moved.deliveries].map(({ id }) => id)
    const before = positions(db, allIds)

    expect(() =>
      db!.messages.deliveries.reorderAll(
        setup.roomId,
        [moved.message.id, first.message.id],
        moved.message.id
      )
    ).toThrow('room_delivery_queue_stale')
    expect(positions(db, allIds)).toEqual(before)
  })
})

function createRoom(agentCount: number) {
  const db = new RoomDatabase(':memory:')
  const snapshot = db.createRoom({ projectId: 'project', name: 'room' })
  const agents = Array.from({ length: agentCount }, (_, index) =>
    db.participants.add({
      roomId: snapshot.room.id,
      identity: `agent-${index}`,
      displayName: `Agent ${index}`,
      agent: 'codex'
    })
  )
  return {
    db,
    roomId: snapshot.room.id,
    agents,
    create: (body: string, targetParticipantIds?: string[]) =>
      db.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0]!.id,
        senderIdentity: 'user',
        actorKind: 'user',
        body,
        targetParticipantIds
      })
  }
}

function deliveryFor(db: RoomDatabase, messageId: string, participantId: string) {
  return db.messages.deliveries
    .listForMessage(messageId)
    .find((delivery) => delivery.participantId === participantId)!
}

function positions(db: RoomDatabase, ids: string[]): (number | null | undefined)[] {
  return ids.map((id) => db.messages.deliveries.get(id).queuePosition)
}
