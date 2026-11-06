import { useState } from 'react'
import {
  buildMobileNativeChatTransientData,
  type MobileNativeChatPendingItem
} from '../mobile-native-chat-render-data'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { orderNativeChatDisplayMessages } from '../../../../../src/shared/native-chat/transcript/native-chat-message-order'

type Input = Parameters<typeof buildMobileNativeChatTransientData>[0]
type Preview = { urls: readonly string[]; row: NativeChatMessage }
type Pending = { input: MobileNativeChatPendingItem; row: NativeChatMessage }
export type MobileNativeChatTransientProjection = {
  input: Input
  previews: ReadonlyMap<NativeChatMessage, Preview>
  pending: ReadonlyMap<string, Pending>
  stream: NativeChatMessage | undefined
  data: NativeChatMessage[]
}

function sameUrls(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.length === right.length &&
      left.every((url, index) => url === right[index]))
  )
}

export function projectMobileNativeChatTransientData(
  input: Input,
  before?: MobileNativeChatTransientProjection
): MobileNativeChatTransientProjection {
  const previews = new Map<NativeChatMessage, Preview>()
  const folded = input.folded.map((source) => {
    const urls = input.imagePreviewsByMessageId?.[source.id]
    if (source.role !== 'user' || !urls?.length) {
      return source
    }
    const held = before?.previews.get(source)
    const preview =
      held && sameUrls(held.urls, urls)
        ? held
        : {
            urls,
            row: buildMobileNativeChatTransientData({
              ...input,
              folded: [source],
              streaming: null,
              pending: []
            }).folded[0]!
          }
    previews.set(source, preview)
    return preview.row
  })
  const pending = new Map<string, Pending>()
  const transient = input.pending.map((item) => {
    const held = before?.pending.get(item.id)
    const old = held?.input
    const entry =
      held &&
      old &&
      old.text === item.text &&
      old.sentAt === item.sentAt &&
      old.pendingSend === item.pendingSend &&
      sameUrls(old.images, item.images)
        ? held
        : {
            input: item,
            row: buildMobileNativeChatTransientData({
              folded: [],
              streaming: null,
              pending: [item]
            }).data[0]!
          }
    pending.set(item.id, entry)
    return entry.row
  })
  const stream = input.streaming
    ? before?.input.streaming === input.streaming
      ? before.stream
      : buildMobileNativeChatTransientData({ folded: [], streaming: input.streaming, pending: [] })
          .data[0]
    : undefined
  const data = [
    ...folded,
    ...orderNativeChatDisplayMessages([...(stream ? [stream] : []), ...transient])
  ]
  return {
    input,
    previews,
    pending,
    stream,
    data:
      before &&
      data.length === before.data.length &&
      data.every((row, index) => row === before.data[index])
        ? before.data
        : data
  }
}

export function useMobileNativeChatTransientData(input: Input, scope: string): NativeChatMessage[] {
  const [state, setState] = useState(() => ({
    scope,
    projection: projectMobileNativeChatTransientData(input)
  }))
  const previous = state.projection.input
  if (
    state.scope === scope &&
    input.folded === previous.folded &&
    input.streaming === previous.streaming &&
    input.pending === previous.pending &&
    input.imagePreviewsByMessageId === previous.imagePreviewsByMessageId
  ) {
    return state.projection.data
  }
  const projection = projectMobileNativeChatTransientData(
    input,
    state.scope === scope ? state.projection : undefined
  )
  setState({ scope, projection })
  return projection.data
}
