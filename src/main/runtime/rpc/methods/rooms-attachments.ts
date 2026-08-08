import { z } from 'zod'
import { ROOM_ATTACHMENT_MAX_BYTES } from '../../rooms/attachments'
import { defineMethod, type RpcAnyMethod } from '../core'
import { RoomId } from './rooms-schemas'

const UploadId = z.string().uuid()
const TransferId = z.string().uuid()

export const ROOM_ATTACHMENT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.attachments.upload.start',
    params: z
      .object({
        roomId: RoomId,
        fileName: z.string().trim().min(1).max(240),
        byteSize: z.number().int().nonnegative().max(ROOM_ATTACHMENT_MAX_BYTES)
      })
      .strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      return service.attachmentTransfers.startUpload(
        params.roomId,
        params.fileName,
        params.byteSize
      )
    }
  }),
  defineMethod({
    name: 'rooms.attachments.upload.append',
    params: z
      .object({
        uploadId: UploadId,
        offset: z.number().int().nonnegative(),
        contentBase64: z.string().max(600_000)
      })
      .strict(),
    handler: async (params, { runtime }) =>
      runtime
        .getRoomService()
        .attachmentTransfers.appendUpload(params.uploadId, params.offset, params.contentBase64)
  }),
  defineMethod({
    name: 'rooms.attachments.upload.finish',
    params: z.object({ uploadId: UploadId }).strict(),
    handler: async (params, { runtime }) => {
      runtime.getRoomService().attachmentTransfers.finishUpload(params.uploadId)
      return { ready: true }
    }
  }),
  defineMethod({
    name: 'rooms.attachments.upload.cancel',
    params: z.object({ uploadId: UploadId }).strict(),
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().attachmentTransfers.cancelUpload(params.uploadId)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'rooms.attachments.download.start',
    params: z.object({ roomId: RoomId, attachmentId: z.string().uuid() }).strict(),
    handler: async (params, { runtime }) =>
      runtime.getRoomService().attachmentTransfers.startDownload(params.roomId, params.attachmentId)
  }),
  defineMethod({
    name: 'rooms.attachments.download.read',
    params: z.object({ transferId: TransferId, offset: z.number().int().nonnegative() }).strict(),
    handler: async (params, { runtime }) =>
      runtime.getRoomService().attachmentTransfers.readDownload(params.transferId, params.offset)
  }),
  defineMethod({
    name: 'rooms.attachments.download.cancel',
    params: z.object({ transferId: TransferId }).strict(),
    handler: async (params, { runtime }) => {
      runtime.getRoomService().attachmentTransfers.cancelDownload(params.transferId)
      return { cancelled: true }
    }
  })
]
