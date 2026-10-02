import { afterEach, describe, expect, it } from 'vitest'
import { RoomArchive } from './archive'
import { RoomDatabase } from './database'

describe('RoomArchive', () => {
  const databases: RoomDatabase[] = []

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close()
    }
  })

  it('round-trips Agentchattr-compatible history and merges idempotently', async () => {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const source = database.createRoom({
      projectId: 'project-1',
      name: 'Source',
      userIdentity: 'egor'
    })
    const first = database.messages.create({
      roomId: source.room.id,
      senderId: source.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Hypothesis'
    }).message
    const reply = database.messages.create({
      roomId: source.room.id,
      senderId: source.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Evidence',
      replyToId: first.id
    }).message
    const archive = new RoomArchive(database)
    const bytes = await archive.export(source.room.id)
    const target = database.createRoom({
      projectId: 'project-1',
      name: 'Target',
      userIdentity: 'egor'
    })
    const firstReport = await archive.import(target.room.id, bytes)
    expect(firstReport).toMatchObject({
      messages: { created: 2, duplicates: 0 }
    })
    const imported = database.messages.list(target.room.id, null, 20).messages
    expect(imported.map((message) => message.body)).toEqual(['Hypothesis', 'Evidence'])
    expect(imported[1].replyToId).toBe(imported[0].id)
    const secondReport = await archive.import(target.room.id, bytes)
    expect(secondReport).toMatchObject({
      messages: { created: 0, duplicates: 2 }
    })
    expect(database.messages.list(target.room.id, null, 20).messages).toHaveLength(2)

    const sourceReport = await archive.import(source.room.id, bytes)
    expect(sourceReport.messages).toMatchObject({ created: 0, duplicates: 2 })
    expect(database.messages.get(reply.id).replyToId).toBe(first.id)
  })
})
