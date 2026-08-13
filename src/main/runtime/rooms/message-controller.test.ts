import { describe, expect, it } from 'vitest'
import type { RoomAttachmentManager } from './attachments'
import { RoomDatabase } from './database'
import { RoomMessageController } from './message-controller'

describe('room message recipients', () => {
  it('delivers every message to active agents and keeps recipients structured', async () => {
    const database = new RoomDatabase(':memory:')
    try {
      const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
      const user = snapshot.participants[0]
      const codex = database.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex'
      })
      const claude = database.participants.add({
        roomId: snapshot.room.id,
        identity: 'claude',
        displayName: 'Claude',
        agent: 'claude'
      })
      const controller = new RoomMessageController(
        database,
        {
          consumeUploads: async () => [],
          remove: async () => {}
        } as unknown as RoomAttachmentManager,
        () => {},
        () => {}
      )

      const prose = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Discuss @codex without invoking it.'
      })
      expect(prose.mentions).toEqual([])
      expect(
        database.messages.deliveries
          .listForMessage(prose.id)
          .map((delivery) => delivery.participantId)
          .sort()
      ).toEqual([claude.id, codex.id].sort())

      const code = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: '```ts\nconst reviewer = "@codex"\n```'
      })
      expect(code.mentions).toEqual([])
      expect(database.messages.deliveries.listForMessage(code.id)).toHaveLength(2)

      const directed = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Please review.',
        mentions: ['codex']
      })
      expect(directed.mentions).toEqual(['codex'])
      expect(database.messages.deliveries.listForMessage(directed.id)).toHaveLength(2)

      database.participants.update(codex.id, { participation: 'paused' })
      const paused = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Please review after pause.',
        mentions: ['codex']
      })
      expect(database.messages.deliveries.listForMessage(paused.id)).toMatchObject([
        { participantId: claude.id }
      ])

      database.participants.update(codex.id, { participation: 'active' })
      const resumed = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Only this future message is delivered after resume.'
      })
      expect(database.messages.deliveries.listForMessage(paused.id)).toMatchObject([
        { participantId: claude.id }
      ])
      expect(database.messages.deliveries.listForMessage(resumed.id)).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('supersedes a completed room stop only after the next user message is accepted', async () => {
    const database = new RoomDatabase(':memory:')
    try {
      const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
      const user = snapshot.participants[0]
      const codex = database.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex'
      })
      const controller = new RoomMessageController(
        database,
        {
          consumeUploads: async () => [],
          remove: async () => {}
        } as unknown as RoomAttachmentManager,
        () => {},
        () => {}
      )
      const first = await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Start'
      })
      const delivery = database.messages.deliveries.listForMessage(first.id)[0]
      database.messages.deliveries.claim(delivery.id)
      database.messages.deliveries.setPhase(delivery.id, 'awaiting-turn')
      const stopped = database.transaction(() =>
        database.messages.deliveries.stopRoom(snapshot.room.id)
      )

      await expect(
        controller.send({
          roomId: snapshot.room.id,
          senderIdentity: user.identity,
          body: 'Too early'
        })
      ).rejects.toThrow('room_stop_in_progress')
      expect(database.messages.deliveries.get(delivery.id).error).toBe('room_stopping')

      database.messages.deliveries.finishRoomStop(
        stopped.deliveries.map((stoppedDelivery) => stoppedDelivery.id)
      )
      database.participants.update(codex.id, { participation: 'paused' })
      await controller.send({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: 'Replace the stopped work'
      })

      expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_stopped_superseded'
      })
      expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('idle')
      expect(database.messages.deliveries.resumeRoom(snapshot.room.id)).toEqual([])
    } finally {
      database.close()
    }
  })
})
