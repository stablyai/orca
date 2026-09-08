import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineStreamingMethod, isStreamingMethod } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { boundMobileWebNativeChatRead } from './mobile-web-native-chat-read-budget'
import {
  MobileWebChatTarget,
  mobileWebNativeChatHostParams,
  resolveMobileWebNativeChat
} from './mobile-web-native-chat-binding'

const source = NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.subscribe')
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing native chat stream')
}
const stream = source

export const MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD = defineStreamingMethod({
  name: 'mobileWeb.nativeChat.subscribe',
  params: MobileWebChatTarget.extend({ read: z.record(z.string(), z.unknown()) }),
  handler: async (params, context, emit) => {
    const binding = await resolveMobileWebNativeChat(context, params)
    if (context.signal?.aborted) {
      return
    }
    const subscriptionId = randomUUID()
    const input = stream.params!.parse({
      ...mobileWebNativeChatHostParams(binding, params.read),
      subscriptionId
    })
    let ready = false
    let closed = false
    const announce = () => {
      if (!ready) {
        ready = true
        emit({ type: 'ready', subscriptionId })
      }
    }
    const cleanup = () =>
      context.runtime.cleanupSubscription(
        `nativeChat:${context.connectionId ?? 'local'}:${subscriptionId}`
      )
    try {
      await stream.handler(input, context, (event) => {
        if (closed) {
          return
        }
        announce()
        if (closed) {
          return
        }
        const type =
          typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
        if (type === 'end' || type === 'error') {
          closed = true
          emit(event)
          return
        }
        const current = context.runtime.resolveNativeChatTranscriptBinding(binding.terminal)
        if (
          !current ||
          current.worktreeId !== binding.worktreeId ||
          current.agent !== binding.agent ||
          current.providerSession?.id !== binding.sessionId ||
          current.providerSession.transcriptPath !== binding.transcriptPath
        ) {
          closed = true
          emit({ type: 'error', message: 'Chat session is no longer available' })
          cleanup()
          return
        }
        let bounded: unknown
        try {
          bounded = boundMobileWebNativeChatRead(event)
        } catch {
          closed = true
          emit({ type: 'error', message: 'Chat event exceeds the response budget' })
          cleanup()
          return
        }
        emit(bounded)
      })
    } catch (error) {
      closed = true
      cleanup()
      throw error
    }
    if (!closed) {
      announce()
    }
  }
})
