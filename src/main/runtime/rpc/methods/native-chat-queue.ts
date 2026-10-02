import {
  NativeChatQueueReadParams,
  NativeChatQueueEnqueueParams,
  NativeChatQueueEditParams,
  NativeChatQueueBeginEditParams,
  NativeChatQueueRemoveParams,
  NativeChatQueueReorderParams,
  NativeChatQueueClaimParams,
  NativeChatQueueAcceptParams,
  NativeChatQueueRejectParams,
  NativeChatQueuePauseParams,
  NativeChatQueueResumeParams,
  NativeChatQueueRetryParams
} from '../../../../shared/rpc-contract/native-chat-queue-params'
import { defineMethod } from '../core'

export const NATIVE_CHAT_QUEUE_METHODS = [
  defineMethod({
    name: 'nativeChat.queue.read',
    params: NativeChatQueueReadParams,
    handler: (params, { runtime }) => runtime.getNativeChatQueueStore().snapshot(params.paneKey)
  }),
  defineMethod({
    name: 'nativeChat.queue.enqueue',
    params: NativeChatQueueEnqueueParams,
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
    params: NativeChatQueueEditParams,
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
    params: NativeChatQueueBeginEditParams,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .beginEdit(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.remove',
    params: NativeChatQueueRemoveParams,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .remove(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.reorder',
    params: NativeChatQueueReorderParams,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .reorder(params.paneKey, params.messageIds, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.claim',
    params: NativeChatQueueClaimParams,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().claim(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.accept',
    params: NativeChatQueueAcceptParams,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .accept(params.paneKey, params.messageId, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.reject',
    params: NativeChatQueueRejectParams,
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
    params: NativeChatQueuePauseParams,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().pause(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.resume',
    params: NativeChatQueueResumeParams,
    handler: (params, { runtime }) =>
      runtime.getNativeChatQueueStore().resume(params.paneKey, params.expectedRevision)
  }),
  defineMethod({
    name: 'nativeChat.queue.retry',
    params: NativeChatQueueRetryParams,
    handler: (params, { runtime }) =>
      runtime
        .getNativeChatQueueStore()
        .retry(params.paneKey, params.messageId, params.expectedRevision)
  })
]
