import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  HarnessAgent,
  MessageId,
  ParticipantConnection,
  ParticipantId,
  ReaderKey,
  RoomId,
  RoomIdentity,
  RoomSubscription
} from './rooms-schemas'
import { ROOM_WORK_METHODS } from './rooms-work'
import { ROOM_NOTIFICATION_METHODS } from './rooms-notifications'
import { ROOM_EXISTING_PARTICIPANT_METHOD } from './rooms-participant-existing'

const Unsubscribe = z.object({ subscriptionId: z.string().trim().min(1).max(256) }).strict()

export const ROOM_CORE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'rooms.list',
    params: z
      .object({
        projectId: z.string().trim().min(1).max(512)
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      rooms: runtime.getRoomService().listRooms(params.projectId)
    })
  }),
  defineMethod({
    name: 'rooms.create',
    params: z
      .object({
        projectId: z.string().trim().min(1).max(512),
        worktreeId: z.string().trim().min(1).max(1024).nullable().optional(),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(4000).optional(),
        userIdentity: RoomIdentity.optional(),
        userDisplayName: z.string().trim().min(1).max(120).optional()
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      snapshot: runtime.getRoomService().createRoom(params)
    })
  }),
  defineMethod({
    name: 'rooms.snapshot',
    params: z.object({ roomId: RoomId, readerKey: ReaderKey }).strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      // The header must render instantly from persisted state; harness
      // reconciliation can take minutes and streams participant.updated events.
      void service.activateRoom(params.roomId, params.readerKey).catch(() => {})
      return { snapshot: service.snapshot(params.roomId, params.readerKey) }
    }
  }),
  defineStreamingMethod({
    name: 'rooms.subscribe',
    params: RoomSubscription,
    handler: async (params, { runtime, connectionId }, emit) => {
      const key = `rooms:${connectionId ?? 'local'}:${params.subscriptionId}`
      let deleted = false
      const unsubscribe = runtime
        .getRoomService()
        .subscribe(params.roomId, params.readerKey, (event) => {
          emit(event)
          if (event.type === 'end' && event.reason === 'deleted') {
            deleted = true
            queueMicrotask(() => runtime.cleanupSubscription(key))
          }
        })
      runtime.registerSubscriptionCleanup(
        key,
        () => {
          unsubscribe()
          if (!deleted) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )
    }
  }),
  defineMethod({
    name: 'rooms.unsubscribe',
    params: Unsubscribe,
    handler: async (params, { runtime, connectionId }) => {
      runtime.cleanupSubscription(`rooms:${connectionId ?? 'local'}:${params.subscriptionId}`)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'rooms.messages.list',
    params: z
      .object({
        roomId: RoomId,
        beforeSequence: z.number().int().positive().nullable().optional(),
        limit: z.number().int().min(1).max(200).default(100)
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      page: runtime
        .getRoomService()
        .listMessages(params.roomId, params.beforeSequence ?? null, params.limit)
    })
  }),
  defineMethod({
    name: 'rooms.messages.send',
    params: z
      .object({
        roomId: RoomId,
        body: z.string().max(262_144),
        replyToId: MessageId.nullable().optional(),
        mentions: z.array(RoomIdentity).max(50).optional(),
        attachmentUploadIds: z.array(z.string().uuid()).max(10).optional()
      })
      .strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      return {
        message: await service.sendMessage({
          ...params,
          senderIdentity: service.getUserParticipant(params.roomId).identity
        })
      }
    }
  }),
  defineMethod({
    name: 'rooms.messages.update',
    params: z
      .object({
        messageId: MessageId,
        body: z.string().min(1).max(262_144)
      })
      .strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.messages.get(params.messageId)
      return {
        message: service.updateMessage(
          current.id,
          service.getUserParticipant(current.roomId).identity,
          params.body
        )
      }
    }
  }),
  defineMethod({
    name: 'rooms.messages.delete',
    params: z.object({ messageId: MessageId }).strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.messages.get(params.messageId)
      await service.deleteMessage(current.id, service.getUserParticipant(current.roomId).identity)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'rooms.read',
    params: z
      .object({
        roomId: RoomId,
        readerKey: ReaderKey,
        sequence: z.number().int().nonnegative()
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      unread: runtime.getRoomService().markRead(params.roomId, params.readerKey, params.sequence)
    })
  }),
  defineMethod({
    name: 'rooms.participants.add',
    params: z
      .object({
        roomId: RoomId,
        identity: RoomIdentity,
        displayName: z.string().trim().min(1).max(120),
        agent: HarnessAgent,
        roleId: z.string().uuid().nullable().optional(),
        connection: ParticipantConnection,
        machineStreaming: z.boolean().optional(),
        trusted: z.boolean().optional()
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      participant: await runtime.getRoomService().addParticipant(params)
    })
  }),
  ROOM_EXISTING_PARTICIPANT_METHOD,
  defineMethod({
    name: 'rooms.participants.remove',
    params: z.object({ participantId: ParticipantId }).strict(),
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().removeParticipant(params.participantId)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'rooms.participants.reveal',
    params: z
      .object({
        participantId: ParticipantId,
        viewMode: z.enum(['terminal', 'chat'])
      })
      .strict(),
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().revealParticipant(params.participantId, params.viewMode)
      return { revealed: true }
    }
  }),
  defineMethod({
    name: 'rooms.participants.update',
    params: z
      .object({
        participantId: ParticipantId,
        identity: RoomIdentity.optional(),
        displayName: z.string().trim().min(1).max(120).optional(),
        roleId: z.string().uuid().nullable().optional(),
        participation: z.enum(['active', 'paused']).optional()
      })
      .strict(),
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.participants.get(params.participantId)
      service.assertWritable(current.roomId)
      const participant = service.db.participants.update(current.id, params)
      service.emitEvent(participant.roomId, { type: 'participant.updated', participant })
      return { participant }
    }
  }),
  defineMethod({
    name: 'rooms.participants.compact',
    params: z.object({ participantId: ParticipantId }).strict(),
    handler: async (params, { runtime }) => ({
      participant: await runtime.getRoomService().compactParticipant(params.participantId)
    })
  }),
  defineMethod({
    name: 'rooms.participants.control',
    params: z
      .object({
        participantId: ParticipantId,
        command: z.string().trim().min(1).max(256)
      })
      .strict(),
    handler: async (params, { runtime }) => ({
      participant: await runtime
        .getRoomService()
        .controlParticipant(params.participantId, params.command)
    })
  }),
  defineMethod({
    name: 'rooms.participants.configure',
    params: z
      .object({
        participantId: ParticipantId,
        model: z.string().trim().min(1).max(256).optional(),
        effort: z.string().trim().min(1).max(64).optional(),
        mode: z.string().trim().min(1).max(64).optional()
      })
      .strict(),
    handler: async ({ participantId, ...preferences }, { runtime }) => ({
      participant: await runtime.getRoomService().reconfigureParticipant(participantId, preferences)
    })
  }),
  defineMethod({
    name: 'rooms.deliveries.retry',
    params: z.object({ deliveryId: z.string().uuid() }).strict(),
    handler: async (params, { runtime }) => {
      runtime.getRoomService().retryDelivery(params.deliveryId)
      return { retried: true }
    }
  }),
  ...ROOM_WORK_METHODS,
  ...ROOM_NOTIFICATION_METHODS
]
