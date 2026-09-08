import { MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD } from './mobile-web-native-chat-mutations'
import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { boundMobileWebNativeChatRead } from './mobile-web-native-chat-read-budget'
import {
  MobileWebChatTarget,
  mobileWebNativeChatHostParams,
  resolveMobileWebNativeChat
} from './mobile-web-native-chat-binding'

const read = NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.readSession')
if (!read || isStreamingMethod(read)) {
  throw new Error('Missing native chat reader')
}
const reader = read

export const MOBILE_WEB_NATIVE_CHAT_METHODS = [
  defineMethod({
    name: 'mobileWeb.nativeChat.read',
    params: MobileWebChatTarget.extend({ read: z.record(z.string(), z.unknown()) }),
    handler: async (params, context) => {
      const binding = await resolveMobileWebNativeChat(context, params)
      const input = reader.params!.parse(mobileWebNativeChatHostParams(binding, params.read))
      const result = await reader.handler(input, context)
      // The reader answers an unreachable transcript with `{ error }`; the page must see a
      // retryable host failure, not a result it cannot parse.
      if (isRecord(result) && !('messages' in result)) {
        throw new Error('runtime_unavailable')
      }
      return boundMobileWebNativeChatRead(result)
    }
  }),
  MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
