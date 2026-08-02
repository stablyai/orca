import type { NativeChatMessage } from '../../shared/native-chat-types'

const recordOffsets = new WeakMap<NativeChatMessage, number>()

export function markTranscriptRecordOffset(message: NativeChatMessage, offset: number): void {
  recordOffsets.set(message, offset)
}

export function transcriptRecordOffset(message: NativeChatMessage): number | undefined {
  return recordOffsets.get(message)
}
