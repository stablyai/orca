import { enqueueMobileDictationAudioChunk } from '../hooks/mobile-dictation-audio-chunk'
import { MobileDictationPendingAudioBudget } from '../hooks/mobile-dictation-pending-audio-budget'
import type { RpcClient } from '../transport/rpc-client'

export class MobileWebSpeechAudioForwarder {
  private readonly pendingChunks = new Set<Promise<void>>()
  private readonly pendingAudio = new MobileDictationPendingAudioBudget()

  forward(args: {
    client: RpcClient
    dictationId: string
    event: { data: Uint8Array }
    isCurrent: () => boolean
    fail: (error: unknown) => void
  }): void {
    enqueueMobileDictationAudioChunk(args.client, args.dictationId, args.event, {
      pendingChunks: this.pendingChunks,
      pendingAudioBudget: this.pendingAudio,
      shouldReleaseBudget: () => args.isCurrent(),
      failActiveDictation: (dictationId, error) => {
        if (dictationId === args.dictationId && args.isCurrent()) {
          args.fail(error)
        }
      }
    })
  }

  async drain(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingChunks))
  }

  reset(): void {
    this.pendingChunks.clear()
    this.pendingAudio.reset()
  }
}
