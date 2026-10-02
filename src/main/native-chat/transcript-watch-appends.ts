import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  readIncrementalTranscriptMessages,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import type { NativeChatLineDecoder } from './transcript-line-decoders'
import type { NativeChatTurnLifecycleDecoder } from './transcript-turn-lifecycle'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

export async function readTranscriptWatchAppends(input: {
  filePath: string
  state: IncrementalTranscriptState
  decode: NativeChatLineDecoder
  args: Pick<SubscribeNativeChatTranscriptArgs, 'onAppend' | 'onOpaqueAppend'>
  decodeLifecycle: NativeChatTurnLifecycleDecoder | null
  signal: AbortSignal
  isClosed: () => boolean
}): Promise<void> {
  const { filePath, state, decode, args, decodeLifecycle, signal, isClosed } = input
  let lifecycle: NativeChatTurnLifecycle | undefined
  let emitted = false
  const startOffset = state.offset
  const remaining = await readIncrementalTranscriptMessages(
    filePath,
    state,
    decode,
    (messages) => {
      if (!isClosed()) {
        emitted = true
        args.onAppend(messages)
      }
    },
    decodeLifecycle ?? undefined,
    (nextLifecycle) => {
      lifecycle = nextLifecycle
    },
    signal
  )
  if (!isClosed() && (remaining.length > 0 || lifecycle)) {
    emitted = true
    args.onAppend(remaining, lifecycle)
  }
  if (!isClosed() && !emitted && state.offset > startOffset) {
    args.onOpaqueAppend?.()
  }
}
