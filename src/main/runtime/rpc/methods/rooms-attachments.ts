import {
  RoomsAttachmentsUploadStartParams,
  RoomsAttachmentsUploadAppendParams,
  RoomsAttachmentsUploadFinishParams,
  RoomsAttachmentsUploadCancelParams,
  RoomsAttachmentsDownloadStartParams,
  RoomsAttachmentsDownloadReadParams,
  RoomsAttachmentsDownloadCancelParams
} from '../../../../shared/rpc-contract/rooms-attachments-params'

import { defineMethod } from '../core'

export const ROOM_ATTACHMENT_METHODS = [
  defineMethod({
    name: 'rooms.attachments.upload.start',
    params: RoomsAttachmentsUploadStartParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      return service.startAttachmentUpload(params.roomId, params.fileName, params.byteSize)
    }
  }),
  defineMethod({
    name: 'rooms.attachments.upload.append',
    params: RoomsAttachmentsUploadAppendParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(service.attachmentTransfers.uploadRoomId(params.uploadId))
      return service.attachmentTransfers.appendUpload(
        params.uploadId,
        params.offset,
        params.contentBase64
      )
    }
  }),
  defineMethod({
    name: 'rooms.attachments.upload.finish',
    params: RoomsAttachmentsUploadFinishParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(service.attachmentTransfers.uploadRoomId(params.uploadId))
      service.attachmentTransfers.finishUpload(params.uploadId)
      return { ready: true }
    }
  }),
  defineMethod({
    name: 'rooms.attachments.upload.cancel',
    params: RoomsAttachmentsUploadCancelParams,
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().attachmentTransfers.cancelUpload(params.uploadId)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'rooms.attachments.download.start',
    params: RoomsAttachmentsDownloadStartParams,
    handler: async (params, { runtime }) =>
      runtime.getRoomService().startAttachmentDownload(params.roomId, params.attachmentId)
  }),
  defineMethod({
    name: 'rooms.attachments.download.read',
    params: RoomsAttachmentsDownloadReadParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(service.attachmentTransfers.downloadRoomId(params.transferId))
      return service.attachmentTransfers.readDownload(params.transferId, params.offset)
    }
  }),
  defineMethod({
    name: 'rooms.attachments.download.cancel',
    params: RoomsAttachmentsDownloadCancelParams,
    handler: async (params, { runtime }) => {
      runtime.getRoomService().attachmentTransfers.cancelDownload(params.transferId)
      return { cancelled: true }
    }
  })
]
