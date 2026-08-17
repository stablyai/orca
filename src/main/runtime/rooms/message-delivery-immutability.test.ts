import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import type { RoomAttachmentManager } from './attachments'
import { RoomDatabase } from './database'
import { claimRoomBroadcastForTest } from './delivery-test-claim'
import { RoomMessageController } from './message-controller'

describe('room message delivery immutability', () => {
  const databases: RoomDatabase[] = []
  const directories: string[] = []

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close()
    }
    while (directories.length > 0) {
      rmSync(directories.pop()!, { recursive: true, force: true })
    }
  })

  it('keeps inline queue edits unpublished', () => {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const snapshot = database.createRoom({ projectId: 'project', name: 'Room' })
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'agent',
      displayName: 'Agent',
      agent: 'codex'
    })
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Queued',
      targetParticipantIds: [agent.id]
    })
    const controller = new RoomMessageController(
      database,
      {} as RoomAttachmentManager,
      () => undefined,
      () => undefined
    )

    expect(
      controller.update(created.message.id, snapshot.participants[0].identity, 'Changed')
    ).toMatchObject({ body: 'Changed', editedAt: null })
  })

  it('survives deletion of the only participant carrying attempted delivery evidence', () => {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const snapshot = database.createRoom({ projectId: 'project', name: 'Room' })
    const first = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'first',
      displayName: 'First',
      agent: 'codex'
    })
    const second = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'second',
      displayName: 'Second',
      agent: 'codex'
    })
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Already sent',
      targetParticipantIds: [first.id]
    })
    expect(() =>
      database.transaction(() => {
        database.messages.deliveries.claim(created.deliveries[0].id)
        throw new Error('rollback')
      })
    ).toThrow('rollback')
    expect(database.messages.get(created.message.id).deliveryAttempted).toBe(false)
    expect(database.messages.deliveries.get(created.deliveries[0].id).attempts).toBe(0)
    expect(database.messages.deliveries.claim(created.deliveries[0].id)).not.toBeNull()
    database.participants.remove(first.id)

    expect(database.messages.deliveries.listForMessage(created.message.id)).toEqual([])
    expect(database.messages.get(created.message.id).deliveryAttempted).toBe(true)
    const controller = new RoomMessageController(
      database,
      {} as RoomAttachmentManager,
      () => undefined,
      () => undefined
    )
    expect(() =>
      controller.update(created.message.id, snapshot.participants[0].identity, 'Changed')
    ).toThrow('room_delivery_queue_stale')
    expect(() =>
      controller.assertDeletable(created.message.id, snapshot.participants[0].identity)
    ).toThrow('room_delivery_queue_stale')
    expect(() =>
      controller.retarget(created.message.id, snapshot.participants[0].identity, [second.id])
    ).toThrow('room_delivery_queue_stale')
  })

  it('backfills attempted messages while upgrading an existing database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-delivery-attempt-'))
    directories.push(directory)
    const path = join(directory, 'rooms.db')
    const first = new RoomDatabase(path)
    const snapshot = first.createRoom({ projectId: 'project', name: 'Room' })
    const agent = first.participants.add({
      roomId: snapshot.room.id,
      identity: 'agent',
      displayName: 'Agent',
      agent: 'codex'
    })
    const created = first.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Persisted',
      targetParticipantIds: [agent.id]
    })
    claimRoomBroadcastForTest(first, created.message.id)
    first.close()

    const legacy = new SyncDatabase(path)
    legacy.exec(`
      DROP TRIGGER room_delivery_attempt_locks_message;
      ALTER TABLE room_messages DROP COLUMN delivery_attempted;
    `)
    legacy.close()

    const migrated = new RoomDatabase(path)
    databases.push(migrated)
    expect(migrated.messages.get(created.message.id).deliveryAttempted).toBe(true)
    migrated.participants.remove(agent.id)
    expect(() => migrated.messages.deliveries.assertMessageMutable(created.message.id)).toThrow(
      'room_delivery_queue_stale'
    )
  })
})
