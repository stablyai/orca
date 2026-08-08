import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { MessageId, RoomId } from './rooms-schemas'

const TransferId = z.string().uuid()
const ArchiveChunk = z.string().max(600_000)

export const ROOM_MANAGEMENT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.archive.export.start',
    params: z.object({ roomId: RoomId }).strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const room = service.db.core.get(params.roomId)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const safe = room.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'room'
      return service.archiveTransfers.startExport(room.id, `${safe}-${stamp}.zip`)
    }
  }),
  defineMethod({
    name: 'rooms.archive.export.read',
    params: z.object({ transferId: TransferId, offset: z.number().int().nonnegative() }).strict(),
    handler: async (params, { runtime }) =>
      runtime.getRoomService().archiveTransfers.readExport(params.transferId, params.offset)
  }),
  defineMethod({
    name: 'rooms.archive.import.start',
    params: z.object({ roomId: RoomId }).strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      service.assertWritable(params.roomId)
      return service.archiveTransfers.startImport(params.roomId)
    }
  }),
  defineMethod({
    name: 'rooms.archive.import.append',
    params: z.object({ transferId: TransferId, contentBase64: ArchiveChunk }).strict(),
    handler: async (params, { runtime }) =>
      runtime
        .getRoomService()
        .archiveTransfers.appendImport(params.transferId, params.contentBase64)
  }),
  defineMethod({
    name: 'rooms.archive.import.finish',
    params: z.object({ transferId: TransferId }).strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const result = await service.archiveTransfers.finishImport(params.transferId)
      service.emitEvent(result.roomId, {
        type: 'snapshot',
        snapshot: service.snapshot(result.roomId)
      })
      return { report: result.report }
    }
  }),
  defineMethod({
    name: 'rooms.archive.transfer.cancel',
    params: z.object({ transferId: TransferId }).strict(),
    handler: async (params, { runtime }) => {
      runtime.getRoomService().archiveTransfers.cancel(params.transferId)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'rooms.update',
    params: z
      .object({
        roomId: RoomId,
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(4000).optional(),
        loopLimit: z.number().int().min(0).max(20).optional(),
        worktreeId: z.string().trim().min(1).max(1024).nullable().optional(),
        archived: z.boolean().optional()
      })
      .strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.core.get(params.roomId)
      if (current.archivedAt && params.archived !== false) {
        throw new Error('room_archived')
      }
      const { archived, ...changes } = params
      let room = archived === undefined ? current : service.setArchived(params.roomId, archived)
      if (Object.keys(changes).length > 1) {
        room = service.db.core.update(params.roomId, changes)
        service.emitEvent(room.id, { type: 'room.updated', room })
      }
      return { room }
    }
  }),
  defineMethod({
    name: 'rooms.roles.save',
    params: z
      .object({
        roleId: z.string().uuid().optional(),
        roomId: RoomId,
        name: z.string().trim().min(1).max(80),
        prompt: z.string().max(4000)
      })
      .strict(),
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
    params: z.object({ roleId: z.string().uuid() }).strict(),
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
    params: z
      .object({
        roomId: RoomId,
        messageId: MessageId,
        status: z.enum(['todo', 'done'])
      })
      .strict(),
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
    params: z.object({ roomId: RoomId, messageId: MessageId }).strict(),
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
