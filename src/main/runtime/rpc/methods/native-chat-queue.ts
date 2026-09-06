import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'

const Queue = z.object({ paneKey: z.string().min(1).max(1024) }).strict()
const QueueMutation = Queue.extend({ expectedRevision: z.number().int().nonnegative() }).strict()
const QueueMessageMutation = QueueMutation.extend({ messageId: z.string().uuid() }).strict()

export const NATIVE_CHAT_QUEUE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'nativeChat.queue.read',
    params: Queue,
    handler: (params, { runtime }) => runtime.getNativeChatQueueStore().snapshot(params.paneKey)
  }),
  defineMethod({
    name: 'nativeChat.queue.enqueue',
    params: QueueMutation.extend({
      text: z.string(),
      imagePaths: z.array(z.string().min(1)),
      kind: z.enum(['chat', 'command'])
    }).strict(),
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .enqueue(
          params.paneKey,
          params.text,
          params.imagePaths,
          params.kind,
          params.expectedRevision
        )
  }),
  defineMethod({
    name: 'nativeChat.queue.edit',
    params: QueueMessageMutation.extend({
      text: z.string(),
      imagePaths: z.array(z.string().min(1)),
      kind: z.enum(['chat', 'command'])
    }).strict(),
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .edit(
          params.paneKey,
          params.messageId,
          params.text,
          params.imagePaths,
          params.kind,
          params.expectedRevision
        )
  }),
  defineMethod({
    name: 'nativeChat.queue.beginEdit',
    params: QueueMessageMutation,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .beginEdit(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.remove',
    params: QueueMessageMutation,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .remove(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.reorder',
    params: QueueMutation.extend({ messageIds: z.array(z.string().uuid()) }).strict(),
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .reorder(params.paneKey, params.messageIds, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.claim',
    params: QueueMutation,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().claim(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.accept',
    params: QueueMessageMutation,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .accept(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.reject',
    params: QueueMessageMutation.extend({
      uncertain: z.boolean(),
      error: z.string().min(1)
    }).strict(),
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .reject(
          params.paneKey,
          params.messageId,
          params.expectedRevision,
          params.uncertain,
          params.error
        )
  }),
  defineMethod({
    name: 'nativeChat.queue.pause',
    params: QueueMutation,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().pause(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.resume',
    params: QueueMutation,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().resume(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.retry',
    params: QueueMessageMutation,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .retry(params.paneKey, params.messageId, params.expectedRevision)
  })
]
