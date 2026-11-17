import { useEffect, useMemo, useReducer } from 'react'
import {
  createStreamedTextRowProjection,
  rowsBesideStreamedText,
  streamedTextReplacementIndexes
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import {
  isTextBlock,
  type NativeChatMessage
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../../../src/shared/agent-session/view/structured-agent-session-projection'
import { readMobileNativeChatItem } from './mobile-native-chat-item-read'
import type { MobileNativeChatVisualSource } from '../../visual/mobile-native-chat-visual-read'

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
      current: messages,
      entries: new Map<NativeChatMessage, NativeChatMessage>()
    }),
    [client, sessionId]
  )
  const [revision, refresh] = useReducer((revision: number) => revision + 1, 0)
  const base = rowsBesideStreamedText(messages)
  useEffect(() => {
    cache.live = true
    return () => {
      cache.live = false
      cache.entries.clear()
    }
  }, [cache])
  useEffect(() => {
    const retained = new Set(base)
    for (const raw of cache.entries.keys()) {
      if (!retained.has(raw)) {
        cache.entries.delete(raw)
      }
    }
  }, [cache, base])
  const byId = useMemo(() => new Map(base.map((message, index) => [message.id, index])), [base])
  const raw = (id: string): NativeChatMessage | undefined => {
    const index = byId.get(id)
    return index === undefined ? undefined : messages[index]
  }
  const project = useMemo(
    () =>
      createStreamedTextRowProjection(
        (message: NativeChatMessage) => cache.entries.get(message) ?? message
      ),
    [cache, revision]
  )
  const changed = streamedTextReplacementIndexes(base, messages) ?? []
  for (const index of changed) {
    const prior = cache.current[index]
    if (prior && prior !== messages[index]) {
      cache.entries.delete(prior)
    }
  }
  cache.current = messages
  return {
    messages: project(messages),
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
              if (cache.live && cache.current[byId.get(id) ?? -1] === original) {
                cache.entries.set(original, projected)
                refresh()
              }
            }
          }
  }
}
