import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { RoomEvent } from '../../../shared/rooms'
import { RoomDatabase } from './database'
import { RoomTranscriptTurnState } from './transcript-turn-state'

function message(id: string, text: string, phase?: 'commentary' | 'final'): NativeChatMessage {
  return {
    id,
    role: phase ? 'assistant' : 'user',
    assistantPhase: phase,
    blocks: [{ type: 'text', text }],
    timestamp: 20,
    source: 'stream'
  }
}

function setup() {
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project', name: 'test' })
  const participant = db.participants.add({
    roomId: room.room.id,
    identity: 'codex2',
    displayName: 'Codex2',
    agent: 'codex'
  })
  const other = db.participants.add({
    roomId: room.room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex'
  })
  const create = (body: string) =>
    db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: 'user',
      actorKind: 'user',
      body,
      targetParticipantIds: [participant.id]
    })
  const root = create('Original prompt')
  const steer = create('Steer')
  const originalDelivery = root.deliveries.find((d) => d.participantId === participant.id)!
  const steeredDelivery = steer.deliveries.find((d) => d.participantId === participant.id)!
  expect(db.messages.deliveries.claim(originalDelivery.id)).not.toBeNull()
  db.messages.deliveries.confirmTurn(originalDelivery.id, 'turn', 10)
  expect(db.messages.deliveries.claimSteer(steeredDelivery.id)).not.toBeNull()
  const delivery = db.messages.deliveries.confirmTurn(steeredDelivery.id, 'turn', 15)
  expect(delivery.providerTurnId).toBe('turn')
  const events: RoomEvent[] = []
  const state = new RoomTranscriptTurnState(db, (_roomId, event) => events.push(event))
  state.rememberStart(participant, originalDelivery, {
    type: 'activity',
    source: 'transcript',
    turnId: 'turn',
    timestamp: 10,
    messages: []
  })
  return { db, participant, other, root, steer, delivery, events, state }
}

describe('room turn history', () => {
  it('retains earlier output when Stop interrupts the response to a steer', () => {
    const { db, participant, delivery, state } = setup()
    try {
      const pending = [
        message('early', 'Original answer', 'final'),
        message('steer', 'Change course'),
        message('comment', 'Checking the change', 'commentary')
      ]
      state.remember(participant.id, pending, true)
      db.messages.deliveries.stopRoom(participant.roomId)
      const stopped = db.messages.deliveries.get(delivery.id)
      expect(stopped.error).toBe('room_stopping')
      expect(
        state.publishInterrupted(
          participant,
          stopped,
          'session',
          {
            type: 'interrupted',
            source: 'transcript',
            turnId: 'turn',
            timestamp: 80,
            messages: pending
          },
          vi.fn()
        )
      ).toBe(true)
      const replies = db.messages
        .list(participant.roomId, null, 100)
        .messages.filter((m) => m.senderId === participant.id)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        body: 'Original answer',
        metadata: { activity: { state: 'interrupted', completedAt: 80, messages: [pending[2]] } }
      })
      expect(db.messages.deliveries.listForMessage(replies[0].id)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rolls back retained history with a failed final write and retries without duplicates', () => {
    const { db, participant, delivery, state, events } = setup()
    try {
      const pending = [
        message('early', 'Original answer', 'final'),
        message('steer', 'Change course'),
        message('new', 'Updated answer', 'final')
      ]
      state.remember(participant.id, pending, true)
      const createReply = db.providerMessages.createReply.bind(db.providerMessages)
      const spy = vi.spyOn(db.providerMessages, 'createReply').mockImplementation((input) => {
        if (input.providerMessageId === 'new') {
          throw new Error('write failed')
        }
        return createReply(input)
      })
      const publish = () =>
        state.publishFinal(
          participant,
          delivery,
          'session',
          { type: 'final', source: 'transcript', turnId: 'turn', timestamp: 80, messages: pending },
          vi.fn()
        )
      expect(publish).toThrow('write failed')
      expect(
        db.messages
          .list(participant.roomId, null, 100)
          .messages.filter((m) => m.senderId === participant.id)
      ).toEqual([])
      expect(db.messages.deliveries.get(delivery.id).respondedAt).toBeNull()
      expect(events).toEqual([])
      spy.mockRestore()
      expect(publish()).toBe(true)
      expect(
        db.messages
          .list(participant.roomId, null, 100)
          .messages.filter((m) => m.senderId === participant.id)
          .map((m) => m.body)
      ).toEqual(['Original answer', 'Updated answer'])
    } finally {
      db.close()
    }
  })
  it.each([false, true])(
    'retains an earlier final and activity when the latest reply is silent (replay=%s)',
    (replay) => {
      const { db, participant, root, delivery, state, events } = setup()
      try {
        const commentary = message('commentary', 'Starting sleep', 'commentary')
        const early = message(
          'early',
          'Sleep started. <orca-room-recipients>["codex"]</orca-room-recipients>',
          'final'
        )
        const pending = [
          commentary,
          early,
          message('steer', 'Other reply'),
          message('silent', '<orca-room-silent />', 'final')
        ]
        if (replay) {
          state.remember(participant.id, pending, true)
          state.emitActivity(participant, {
            type: 'activity',
            source: 'transcript',
            turnId: 'turn',
            timestamp: 70,
            messages: pending
          })
          state.disposeParticipant(participant.id)
          state.restore(participant)
          expect(state.entries(participant.id).map(({ message }) => message.id)).toEqual(
            pending.map((message) => message.id)
          )
          db.providerMessages.observeSnapshot(
            participant.id,
            'session',
            pending.map((m) => m.id)
          )
        }
        const publish = () => {
          state.remember(participant.id, pending, !replay)
          return state.publishFinal(
            participant,
            delivery,
            'session',
            {
              type: 'final',
              source: 'transcript',
              turnId: 'turn',
              timestamp: 80,
              messages: pending,
              ...(replay ? { replay: true as const } : {})
            },
            vi.fn()
          )
        }
        expect(publish()).toBe(true)
        const replies = () =>
          db.messages
            .list(participant.roomId, null, 100)
            .messages.filter((m) => m.senderId === participant.id)
        expect(replies()).toHaveLength(1)
        const saved = replies()[0]
        expect(saved).toMatchObject({
          body: 'Sleep started.',
          replyToId: root.message.id,
          mentions: [],
          metadata: { activity: { startedAt: 10, completedAt: 80, messages: [commentary] } }
        })
        expect(db.messages.deliveries.listForMessage(saved.id)).toEqual([])
        expect(
          db.messages.deliveries
            .listForTurn(participant.id, 'turn')
            .every((d) => d.respondedAt === 80 && d.responseMessageId === null)
        ).toBe(true)
        expect(publish()).toBe(true)
        expect(replies()).toHaveLength(1)
        expect(events.filter((e) => e.type === 'message.created')).toHaveLength(1)
      } finally {
        db.close()
      }
    }
  )

  it('keeps the latest visible answer authoritative and routes only that answer', () => {
    const { db, participant, other, steer, delivery, state } = setup()
    try {
      const pending = [
        message('old', 'Old answer', 'final'),
        message('steer', 'Change course'),
        message('new', 'New answer', 'final')
      ]
      state.remember(participant.id, pending, true)
      state.publishFinal(
        participant,
        delivery,
        'session',
        { type: 'final', source: 'transcript', turnId: 'turn', timestamp: 80, messages: pending },
        vi.fn()
      )
      const replies = db.messages
        .list(participant.roomId, null, 100)
        .messages.filter((m) => m.senderId === participant.id)
      expect(replies.map((m) => m.body)).toEqual(['Old answer', 'New answer'])
      expect(db.messages.deliveries.listForMessage(replies[0].id)).toEqual([])
      expect(db.messages.deliveries.listForMessage(replies[1].id)).toMatchObject([
        { participantId: other.id }
      ])
      expect(replies[1].replyToId).toBe(steer.message.id)
      expect(db.messages.deliveries.get(delivery.id).responseMessageId).toBe(replies[1].id)
      expect(replies.filter((m) => m.metadata.activity)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it.each([false, true])(
    'preserves visible activity without inventing a reply (activity=%s)',
    (hasActivity) => {
      const { db, participant, delivery, state } = setup()
      try {
        const pending = [
          ...(hasActivity ? [message('comment', 'Working', 'commentary')] : []),
          message('silent', '<orca-room-silent />', 'final')
        ]
        state.remember(participant.id, pending, true)
        state.publishFinal(
          participant,
          delivery,
          'session',
          { type: 'final', source: 'transcript', turnId: 'turn', timestamp: 80, messages: pending },
          vi.fn()
        )
        const replies = db.messages
          .list(participant.roomId, null, 100)
          .messages.filter((m) => m.senderId === participant.id)
        expect(replies).toHaveLength(hasActivity ? 1 : 0)
        if (hasActivity) {
          expect(replies[0].body).toBe('')
          expect(db.messages.deliveries.listForMessage(replies[0].id)).toEqual([])
        }
      } finally {
        db.close()
      }
    }
  )
})
