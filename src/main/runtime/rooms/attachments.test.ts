import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomAttachmentTransferStore } from './attachment-transfers'
import { RoomAttachmentManager } from './attachments'
import { RoomDatabase } from './database'
import { RoomMessageController } from './message-controller'

describe('room attachment transfers', () => {
  const directories: string[] = []
  const databases: RoomDatabase[] = []

  afterEach(() => {
    while (databases.length) {
      databases.pop()?.close()
    }
    while (directories.length) {
      rmSync(directories.pop()!, { recursive: true, force: true })
    }
  })

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-attachments-'))
    directories.push(directory)
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    const room = database.createRoom({ projectId: 'project-1', name: 'Room', userIdentity: 'user' })
    const manager = new RoomAttachmentManager(join(directory, 'attachments'))
    const transfers = new RoomAttachmentTransferStore(database, manager)
    const messages = new RoomMessageController(
      database,
      manager,
      () => {},
      () => {}
    )
    return { directory, database, room, manager, transfers, messages }
  }

  it('uploads, attaches, authorizes, and downloads a file in bounded chunks', async () => {
    const { database, room, transfers, messages } = setup()
    const bytes = Buffer.from('remote-safe attachment')
    const upload = await transfers.startUpload(room.room.id, 'evidence.txt', bytes.byteLength)
    await transfers.appendUpload(upload.uploadId, 0, bytes.toString('base64'))
    transfers.finishUpload(upload.uploadId)

    const other = database.createRoom({
      projectId: 'project-1',
      name: 'Other',
      userIdentity: 'user'
    })
    await expect(
      messages.send({
        roomId: other.room.id,
        senderIdentity: 'user',
        body: '',
        attachmentUploadIds: [upload.uploadId]
      })
    ).rejects.toThrow('room_attachment_upload_state_invalid')

    const message = await messages.send({
      roomId: room.room.id,
      senderIdentity: 'user',
      body: '',
      attachmentUploadIds: [upload.uploadId]
    })
    const attachment = message.attachments[0]
    const download = await transfers.startDownload(room.room.id, attachment.id)
    const chunk = await transfers.readDownload(download.transferId, 0)

    expect(download).toMatchObject({ fileName: 'evidence.txt', byteLength: bytes.byteLength })
    expect(Buffer.from(chunk.contentBase64, 'base64')).toEqual(bytes)
    expect(chunk.done).toBe(true)

    await expect(transfers.startDownload(other.room.id, attachment.id)).rejects.toThrow(
      'room_attachment_not_found'
    )

    database.core.update(room.room.id, { archived: true })
    expect(existsSync(attachment.localPath)).toBe(true)
    database.core.update(room.room.id, { archived: false })
    await messages.delete(message.id, 'user')
    expect(existsSync(attachment.localPath)).toBe(false)
  })

  it('removes a consumed canonical file when message creation fails', async () => {
    const { directory, database, room, transfers, messages } = setup()
    const upload = await transfers.startUpload(room.room.id, 'failed.txt', 3)
    await transfers.appendUpload(upload.uploadId, 0, Buffer.from('bad').toString('base64'))
    transfers.finishUpload(upload.uploadId)
    const path = join(directory, 'attachments', room.room.id, `${upload.uploadId}.txt`)
    const create = database.messages.create.bind(database.messages)
    database.messages.create = () => {
      throw new Error('database_failed')
    }

    await expect(
      messages.send({
        roomId: room.room.id,
        senderIdentity: 'user',
        body: '',
        attachmentUploadIds: [upload.uploadId]
      })
    ).rejects.toThrow('database_failed')
    expect(existsSync(path)).toBe(false)
    database.messages.create = create
  })

  it('rejects malformed chunks, invalid offsets, and symlink escapes', async () => {
    const { directory, room, manager, transfers } = setup()
    const upload = await transfers.startUpload(room.room.id, 'file.txt', 3)
    await expect(transfers.appendUpload(upload.uploadId, 1, 'YWJj')).rejects.toThrow(
      'room_attachment_upload_state_invalid'
    )
    await expect(transfers.appendUpload(upload.uploadId, 0, 'not base64')).rejects.toThrow(
      'room_attachment_chunk_invalid'
    )

    const root = join(directory, 'attachments')
    const outside = join(directory, 'outside.txt')
    mkdirSync(root, { recursive: true })
    writeFileSync(outside, 'private')
    symlinkSync(outside, join(root, 'escape.txt'))
    await expect(manager.readChunk(join(root, 'escape.txt'), 0)).rejects.toThrow(
      'room_attachment_not_file'
    )
  })
})
