import {
  RoomsDeleteParams,
  RoomsArchiveExportStartParams,
  RoomsArchiveExportReadParams,
  RoomsArchiveImportStartParams,
  RoomsArchiveImportAppendParams,
  RoomsArchiveImportFinishParams,
  RoomsArchiveTransferCancelParams,
  RoomsUpdateParams,
  RoomsRolesSaveParams,
  RoomsRolesDeleteParams,
  RoomsPinsSetParams,
  RoomsPinsRemoveParams
} from '../../../../shared/rpc-contract/rooms-management-params'

import { defineMethod } from '../core'

export const ROOM_MANAGEMENT_METHODS = [
  defineMethod({
    name: 'rooms.delete',
    params: RoomsDeleteParams,
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().deleteRoom(params.roomId)
      return { deleted: true }
    }
  }),
  defineMethod({
    name: 'rooms.archive.export.start',
    params: RoomsArchiveExportStartParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const room = service.db.core.get(params.roomId)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const safe = room.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'room'
      return service.startArchiveExport(room.id, `${safe}-${stamp}.zip`)
    }
  }),
  defineMethod({
    name: 'rooms.archive.export.read',
    params: RoomsArchiveExportReadParams,
    handler: async (params, { runtime }) =>
      runtime.getRoomService().archiveTransfers.readExport(params.transferId, params.offset)
  }),
  defineMethod({
    name: 'rooms.archive.import.start',
    params: RoomsArchiveImportStartParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      return service.archiveTransfers.startImport(params.roomId)
    }
  }),
  defineMethod({
    name: 'rooms.archive.import.append',
    params: RoomsArchiveImportAppendParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(service.archiveTransfers.importRoomId(params.transferId))
      return service.archiveTransfers.appendImport(params.transferId, params.contentBase64)
    }
  }),
  defineMethod({
    name: 'rooms.archive.import.finish',
    params: RoomsArchiveImportFinishParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const result = await service.finishArchiveImport(params.transferId)
      service.emitEvent(result.roomId, {
        type: 'snapshot',
        snapshot: service.snapshot(result.roomId)
      })
      return { report: result.report }
    }
  }),
  defineMethod({
    name: 'rooms.archive.transfer.cancel',
    params: RoomsArchiveTransferCancelParams,
    handler: async (params, { runtime }) => {
      runtime.getRoomService().archiveTransfers.cancel(params.transferId)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'rooms.update',
    params: RoomsUpdateParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      const room = service.db.core.update(params.roomId, params)
      service.emitEvent(room.id, { type: 'room.updated', room })
      return { room }
    }
  }),
  defineMethod({
    name: 'rooms.roles.save',
    params: RoomsRolesSaveParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      const role = service.db.core.saveRole({ id: params.roleId, ...params })
      service.emitEvent(role.roomId, { type: 'role.updated', role })
      return { role }
    }
  }),
  defineMethod({
    name: 'rooms.roles.delete',
    params: RoomsRolesDeleteParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const role = service.db.core.getRole(params.roleId)
      service.assertWritable(role.roomId)
      service.db.core.deleteRole(role.id)
      service.emitEvent(role.roomId, { type: 'role.removed', roleId: role.id })
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'rooms.pins.set',
    params: RoomsPinsSetParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      const pin = service.db.pins.set({
        ...params,
        createdBy: service.getUserParticipant(params.roomId).identity
      })
      service.emitEvent(pin.roomId, {
        type: 'pin.updated',
        pin,
        messageId: pin.messageId
      })
      return { pin }
    }
  }),
  defineMethod({
    name: 'rooms.pins.remove',
    params: RoomsPinsRemoveParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      const pin = service.db.pins
        .list(params.roomId)
        .find((item) => item.messageId === params.messageId)
      if (!pin) {
        throw new Error('room_pin_not_found')
      }
      service.db.pins.remove(params.roomId, params.messageId)
      service.emitEvent(params.roomId, {
        type: 'pin.updated',
        pin: null,
        messageId: params.messageId
      })
      return { removed: true }
    }
  })
]
