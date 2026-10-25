import { useEffect, useMemo, useReducer } from 'react'
import { isTextBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import { readMobileNativeChatItem } from './mobile-native-chat-item-read'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'

export type MobileNativeChatMessageDetail = {
  raw(id: string): NativeChatMessage | undefined
  state(id: string): 'available' | 'partial' | 'complete' | null
  load(id: string): Promise<void>
}

/** Substitute the original raw row; image, skill and tool preparation then run once as usual. */
export function useMobileNativeChatMessageDetail(
  messages: NativeChatMessage[],
  source: MobileNativeChatVisualSource | null
): { messages: NativeChatMessage[]; detail: MobileNativeChatMessageDetail | null } {
  const client = source?.client,
    sessionId = source?.sessionId
  const cache = useMemo(
    () => ({
      live: true,
      raw: new Set<NativeChatMessage>(),
      entries: new Map<NativeChatMessage, NativeChatMessage>()
    }),
    [client, sessionId]
  )
  const [revision, refresh] = useReducer((revision: number) => revision + 1, 0)
  useEffect(() => {
    cache.live = true
    return () => {
      cache.live = false
      cache.entries.clear()
    }
  }, [cache])
  useEffect(() => {
    cache.raw = new Set(messages)
    for (const raw of cache.entries.keys()) {
      if (!cache.raw.has(raw)) {
        cache.entries.delete(raw)
      }
    }
  }, [cache, messages])
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const raw = (id: string): NativeChatMessage | undefined => byId.get(id)
  return {
    messages: useMemo(
      () => messages.map((message) => cache.entries.get(message) ?? message),
      [cache, messages, revision]
    ),
    detail:
      source === null
        ? null
        : {
            raw,
            state: (id) => {
              const original = raw(id)
              if (!original?.shortened || !original.blocks.some(isTextBlock)) {
                return null
              }
              const loaded = cache.entries.get(original)
              return loaded ? (loaded.shortened ? 'partial' : 'complete') : 'available'
            },
            load: async (id) => {
              const original = raw(id)
              if (!original?.shortened || !original.blocks.some(isTextBlock)) {
                throw new Error('Message unavailable')
              }
              const item = await readMobileNativeChatItem(source, id)
              const projected =
                item?.itemId === id && item.body.kind === 'message'
                  ? projectStructuredItemToNativeChat(item)
                  : null
              if (!projected?.blocks.some(isTextBlock)) {
                throw new Error('Message unavailable')
              }
              if (cache.live && cache.raw.has(original)) {
                cache.entries.set(original, projected)
                refresh()
              }
            }
          }
  }
}
