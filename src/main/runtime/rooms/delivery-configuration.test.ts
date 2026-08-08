import { afterEach, describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'

describe('room delivery configuration', () => {
  let database: RoomDatabase | null = null

  afterEach(() => {
    database?.close()
    database = null
  })

  it('sends configuration only when it is new, changed, or explicitly required', () => {
    database = new RoomDatabase(':memory:')
    let snapshot = database.createRoom({
      projectId: 'project-1',
      name: 'Research',
      userIdentity: 'egor'
    })
    let participant = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      roleId: snapshot.roles[0]!.id,
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    const role = snapshot.roles[0]!

    let pending = database.deliveryConfiguration.pending({
      participant,
      room: snapshot.room,
      role
    })
    // Empty description is omitted entirely — never sent as '(none)'.
    expect(pending.configuration).toEqual({ role })
    database.deliveryConfiguration.commit(participant.id, pending.snapshot)
    expect(
      database.deliveryConfiguration.pending({
        participant,
        room: snapshot.room,
        role
      }).configuration
    ).toEqual({})

    database.core.update(snapshot.room.id, { description: 'Updated room purpose' })
    snapshot = database.snapshot(snapshot.room.id)
    pending = database.deliveryConfiguration.pending({
      participant,
      room: snapshot.room,
      role
    })
    expect(pending.configuration).toEqual({ description: 'Updated room purpose' })
    database.deliveryConfiguration.commit(participant.id, pending.snapshot)

    participant = database.participants.update(participant.id, {
      providerSession: { key: 'session_id', id: 'session-2' }
    })
    pending = database.deliveryConfiguration.pending({
      participant,
      room: snapshot.room,
      role
    })
    expect(pending.configuration).toEqual({
      description: 'Updated room purpose',
      role
    })
    database.deliveryConfiguration.commit(participant.id, pending.snapshot)
    database.deliveryConfiguration.requireFull(participant.id)
    expect(
      database.deliveryConfiguration.pending({
        participant,
        room: snapshot.room,
        role
      }).configuration
    ).toEqual({ description: 'Updated room purpose', role })
  })

  it('announces clearing a previously delivered field exactly once', () => {
    database = new RoomDatabase(':memory:')
    let snapshot = database.createRoom({
      projectId: 'project-1',
      name: 'Research',
      userIdentity: 'egor'
    })
    const participant = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    database.core.update(snapshot.room.id, { description: 'Initial purpose' })
    snapshot = database.snapshot(snapshot.room.id)

    let pending = database.deliveryConfiguration.pending({
      participant,
      room: snapshot.room,
      role: null
    })
    expect(pending.configuration).toEqual({ description: 'Initial purpose' })
    database.deliveryConfiguration.commit(participant.id, pending.snapshot)

    database.core.update(snapshot.room.id, { description: '' })
    snapshot = database.snapshot(snapshot.room.id)
    pending = database.deliveryConfiguration.pending({
      participant,
      room: snapshot.room,
      role: null
    })
    expect(pending.configuration).toEqual({ cleared: ['description'] })
    database.deliveryConfiguration.commit(participant.id, pending.snapshot)

    expect(
      database.deliveryConfiguration.pending({
        participant,
        room: snapshot.room,
        role: null
      }).configuration
    ).toEqual({})
  })
})
