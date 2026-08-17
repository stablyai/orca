import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomAttachmentManager } from './attachments'
import { claimRoomBroadcastForTest } from './delivery-test-claim'
import { RoomDatabase } from './database'
import { RoomMessageController } from './message-controller'
import { updateRoomParticipant } from './participant-participation'

describe('dormant room delivery targets', () => {
  let db: RoomDatabase | undefined

  afterEach(() => db?.close())

  it.each([{ extraAgent: false }, { extraAgent: true }])(
    'reloads and atomically places a reactivated target (extraAgent=$extraAgent)',
    ({ extraAgent }) => {
      const setup = createRoom(extraAgent)
      db = setup.db
      const dormant = setup.create('dormant').deliveries[0]!
      participation(db, setup.target.id, 'paused')

      expect(db.messages.listQueued(setup.roomId).messages.map(({ id }) => id)).toContain(
        dormant.messageId
      )

      participation(db, setup.target.id, 'active')
      const anchor = setup.create('anchor').deliveries[0]!
      expect(() =>
        setup.db.transaction(() =>
          setup.db.messages.deliveries.reorder(
            setup.target.id,
            [dormant.id],
            undefined,
            dormant.messageId
          )
        )
      ).toThrow('room_delivery_queue_stale')
      expect(db.messages.deliveries.get(dormant.id).error).toBe('room_participant_paused')
      const emit = vi.fn()
      const controller = new RoomMessageController(db, {} as RoomAttachmentManager, emit, vi.fn())
      controller.reorder(setup.target.id, [dormant.id, anchor.id], undefined, dormant.messageId)

      expect(db.messages.deliveries.get(dormant.id)).toMatchObject({
        state: 'pending',
        error: null
      })
      expect(db.messages.deliveries.get(dormant.id).queuePosition).toBeLessThan(
        db.messages.deliveries.get(anchor.id).queuePosition!
      )
      expect(db.messages.deliveries.isBroadcastMessage(dormant.messageId)).toBe(!extraAgent)
      expect(emit).toHaveBeenCalledWith(
        setup.roomId,
        expect.objectContaining({ type: 'delivery.updated' })
      )
    }
  )

  it('removes one dormant target without activating its sibling', () => {
    const setup = createRoom(true)
    db = setup.db
    const other = db.participants
      .list(setup.roomId)
      .find(
        (participant) => participant.id !== setup.target.id && participant.actorKind === 'agent'
      )!
    const created = db.messages.create({
      roomId: setup.roomId,
      senderId: setup.userId,
      senderIdentity: 'user',
      actorKind: 'user',
      body: 'dormant siblings'
    })
    participation(db, setup.target.id, 'paused')
    participation(db, other.id, 'paused')
    participation(db, setup.target.id, 'active')
    participation(db, other.id, 'active')
    const emit = vi.fn()
    const controller = new RoomMessageController(db, {} as RoomAttachmentManager, emit, vi.fn())

    expect(controller.removeTarget(created.message.id, 'user', setup.target.id)).toBe(false)
    expect(db.messages.deliveries.listForMessage(created.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: setup.target.id,
          state: 'suppressed',
          error: 'room_delivery_retargeted'
        }),
        expect.objectContaining({
          participantId: other.id,
          state: 'suppressed',
          error: 'room_participant_paused'
        })
      ])
    )
    expect(emit).toHaveBeenCalledTimes(1)

    emit.mockClear()
    expect(controller.removeTarget(created.message.id, 'user', other.id)).toBe(true)
    expect(
      db.messages.deliveries
        .listForMessage(created.message.id)
        .find((delivery) => delivery.participantId === other.id)
    ).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not reload a dormant sibling after another target was claimed', () => {
    const setup = createRoom(true)
    db = setup.db
    const other = db.participants
      .list(setup.roomId)
      .find(
        (participant) => participant.id !== setup.target.id && participant.actorKind === 'agent'
      )!
    const created = db.messages.create({
      roomId: setup.roomId,
      senderId: setup.userId,
      senderIdentity: 'user',
      actorKind: 'user',
      body: 'already sending'
    })
    participation(db, other.id, 'paused')
    expect(claimRoomBroadcastForTest(db, created.message.id)).not.toBeNull()

    expect(db.messages.listQueued(setup.roomId).messages.map(({ id }) => id)).not.toContain(
      created.message.id
    )
  })

  it('does not load an agent-authored dormant delivery through the user queue RPC', () => {
    db = new RoomDatabase(':memory:')
    const snapshot = db.createRoom({ projectId: 'project', name: 'room' })
    const author = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'author',
      displayName: 'Author',
      agent: 'codex'
    })
    const target = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'target',
      displayName: 'Target',
      agent: 'claude'
    })
    const created = db.messages.create({
      roomId: snapshot.room.id,
      senderId: author.id,
      senderIdentity: author.identity,
      actorKind: 'agent',
      body: 'agent handoff'
    })
    participation(db, target.id, 'paused')

    expect(db.messages.deliveries.get(created.deliveries[0]!.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    expect(db.messages.listQueued(snapshot.room.id).messages.map(({ id }) => id)).not.toContain(
      created.message.id
    )
  })

  it('keeps an explicitly reactivated dormant target blocked by the room stop flag', () => {
    const setup = createRoom(true)
    db = setup.db
    const other = db.participants
      .list(setup.roomId)
      .find(
        (participant) => participant.id !== setup.target.id && participant.actorKind === 'agent'
      )!
    const dormant = setup.create('dormant').deliveries[0]!
    participation(db, setup.target.id, 'paused')
    db.messages.create({
      roomId: setup.roomId,
      senderId: setup.userId,
      senderIdentity: 'user',
      actorKind: 'user',
      body: 'stop latch',
      targetParticipantIds: [other.id]
    })
    db.messages.deliveries.stopRoom(setup.roomId)
    participation(db, setup.target.id, 'active')

    db.messages.deliveries.retarget(dormant.messageId, [setup.target.id], 100)

    expect(db.messages.deliveries.get(dormant.id).state).toBe('pending')
    expect(db.messages.deliveries.listDue(100)).toEqual([])
    db.messages.deliveries.resumeRoom(setup.roomId, 100)
    expect(db.messages.deliveries.listDue(100).map(({ id }) => id)).toContain(dormant.id)
  })
})

function createRoom(extraAgent: boolean): {
  db: RoomDatabase
  roomId: string
  userId: string
  target: ReturnType<RoomDatabase['participants']['add']>
  create: (body: string) => ReturnType<RoomDatabase['messages']['create']>
} {
  const db = new RoomDatabase(':memory:')
  const snapshot = db.createRoom({ projectId: 'project', name: 'room' })
  const target = db.participants.add({
    roomId: snapshot.room.id,
    identity: 'target',
    displayName: 'Target',
    agent: 'codex'
  })
  if (extraAgent) {
    db.participants.add({
      roomId: snapshot.room.id,
      identity: 'other',
      displayName: 'Other',
      agent: 'claude'
    })
  }
  return {
    db,
    roomId: snapshot.room.id,
    userId: snapshot.participants[0]!.id,
    target,
    create: (body) =>
      db.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0]!.id,
        senderIdentity: 'user',
        actorKind: 'user',
        body,
        targetParticipantIds: [target.id]
      })
  }
}

function participation(db: RoomDatabase, participantId: string, value: 'active' | 'paused'): void {
  updateRoomParticipant(db, participantId, { participation: value }, vi.fn(), vi.fn(), vi.fn())
}
