import { afterEach, describe, expect, it } from 'vitest'
import { RoomArchive } from './archive'
import { RoomArchiveTransferStore } from './archive-transfers'
import { RoomDatabase } from './database'

describe('RoomArchiveTransferStore', () => {
  const databases: RoomDatabase[] = []

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close()
    }
  })

  it('streams a room archive out and back in without a transport-sized frame', async () => {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const source = database.createRoom({
      projectId: 'project-1',
      name: 'Source',
      userIdentity: 'user'
    })
    database.messages.create({
      roomId: source.room.id,
      senderId: source.participants[0].id,
      senderIdentity: 'user',
      actorKind: 'user',
      body: 'Portable history'
    })
    const transfers = new RoomArchiveTransferStore(new RoomArchive(database))
    const exported = await transfers.startExport(source.room.id, 'source.zip')
    const chunks: string[] = []
    let offset = 0
    while (offset < exported.byteLength) {
      const chunk = transfers.readExport(exported.transferId, offset)
      chunks.push(chunk.contentBase64)
      offset = chunk.nextOffset
    }
    transfers.cancel(exported.transferId)

    const target = database.createRoom({
      projectId: 'project-1',
      name: 'Target',
      userIdentity: 'user'
    })
    const imported = transfers.startImport(target.room.id)
    for (const chunk of chunks) {
      transfers.appendImport(imported.transferId, chunk)
    }
    const result = await transfers.finishImport(imported.transferId)

    expect(result.report.messages.created).toBe(1)
    expect(database.messages.list(target.room.id, null, 10).messages[0].body).toBe(
      'Portable history'
    )
  })

  it('rejects non-canonical base64 chunks', () => {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const room = database.createRoom({ projectId: 'project-1', name: 'Room' })
    const transfers = new RoomArchiveTransferStore(new RoomArchive(database))
    const transfer = transfers.startImport(room.room.id)
    expect(() => transfers.appendImport(transfer.transferId, 'not base64')).toThrow(
      'room_archive_chunk_invalid'
    )
  })

  it('reserves bounded memory before concurrent exports start', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const archive = {
      export: async () => {
        await gate
        return Buffer.from('archive')
      }
    } as unknown as RoomArchive
    const transfers = new RoomArchiveTransferStore(archive)
    const first = transfers.startExport('room-1', 'one.zip')
    const second = transfers.startExport('room-2', 'two.zip')

    await expect(transfers.startExport('room-3', 'three.zip')).rejects.toThrow(
      'room_archive_transfers_busy'
    )
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })
})
