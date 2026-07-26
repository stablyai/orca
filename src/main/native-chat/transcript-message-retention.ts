import type { NativeChatMessage } from '../../shared/native-chat-types'

export const MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES = 50_000
export const MAX_NATIVE_CHAT_TRANSCRIPT_RETAINED_BYTES = 64 * 1024 * 1024

type RetainedMessage = {
  message: NativeChatMessage
  estimatedBytes: number
}

export function estimateTranscriptMessageRetainedBytes(sourceBytes: number): number {
  return sourceBytes * 2 + 256
}

export class TranscriptMessageRetention {
  private entries: (RetainedMessage | undefined)[] = []
  private head = 0
  private retained = 0

  constructor(
    private readonly maxMessages = MAX_NATIVE_CHAT_TRANSCRIPT_MESSAGES,
    private readonly maxBytes = MAX_NATIVE_CHAT_TRANSCRIPT_RETAINED_BYTES
  ) {}

  add(message: NativeChatMessage, sourceBytes: number): void {
    const estimatedBytes = estimateTranscriptMessageRetainedBytes(sourceBytes)
    this.entries.push({ message, estimatedBytes })
    this.retained += estimatedBytes
    while (this.size > this.maxMessages || this.retained > this.maxBytes) {
      const oldest = this.entries[this.head]
      this.entries[this.head] = undefined
      this.head += 1
      this.retained -= oldest?.estimatedBytes ?? 0
    }
    if (this.head >= 1_024 && this.head * 2 >= this.entries.length) {
      this.entries.splice(0, this.head)
      this.head = 0
    }
  }

  values(): NativeChatMessage[] {
    const messages: NativeChatMessage[] = []
    for (let index = this.head; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      if (entry) {
        messages.push(entry.message)
      }
    }
    return messages
  }

  get size(): number {
    return this.entries.length - this.head
  }

  get retainedBytes(): number {
    return this.retained
  }
}
