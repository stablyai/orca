import type { NativeChatTurnLifecycle } from '../../../shared/native-chat/native-chat-types'
import type { TranscriptByteRange } from '../../../shared/native-chat/transcript/transcript-byte-range'
import type { NativeChatLineDecoder } from '../transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../transcript-decoding/transcript-turn-lifecycle'
import {
  readIncrementalTranscriptMessages,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

export async function readAndEmitTranscriptAppends(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  args: SubscribeNativeChatTranscriptArgs,
  canPublish: () => boolean,
  signal: AbortSignal
): Promise<void> {
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)
  const { onAppend } = args
  let lifecycle: NativeChatTurnLifecycle | undefined
  let ranges: TranscriptByteRange[] | undefined
  const remaining = await readIncrementalTranscriptMessages(
    filePath,
    state,
    decode,
    (messages, ranges) => {
      if (canPublish()) {
        onAppend(messages, undefined, ranges)
      }
    },
    decodeLifecycle ?? undefined,
    (nextLifecycle) => {
      lifecycle = nextLifecycle
    },
    signal,
    args.sourceOrder,
    (value) => {
      ranges = value
    }
  )
  if (canPublish() && (remaining.length > 0 || lifecycle)) {
    onAppend(remaining, lifecycle, ranges)
  }
}
