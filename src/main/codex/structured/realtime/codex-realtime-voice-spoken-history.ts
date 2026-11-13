import type { CodexVoiceSpokenSegment } from './codex-realtime-voice-context'

const MAX_SEGMENTS = 24
const MAX_THREADS = 32

/** Finished voice segments by thread, for a Codex whose timeline cannot list them yet. Kept in
 *  memory only, so they last until Orca restarts. */
export class CodexVoiceSpokenHistory {
  private readonly threads = new Map<string, CodexVoiceSpokenSegment[]>()

  of(threadId: string): readonly CodexVoiceSpokenSegment[] {
    return this.threads.get(threadId) ?? []
  }

  forget(...threadIds: (string | undefined)[]): void {
    for (const threadId of threadIds) {
      if (threadId) {
        this.threads.delete(threadId)
      }
    }
  }

  remember(threadId: string, segment: CodexVoiceSpokenSegment): void {
    const segments = this.threads.get(threadId) ?? []
    // Re-inserting keeps the most recently heard thread last, so the oldest is dropped first.
    this.threads.delete(threadId)
    this.threads.set(threadId, [...segments, segment].slice(-MAX_SEGMENTS))
    for (const oldest of this.threads.keys()) {
      if (this.threads.size <= MAX_THREADS) {
        break
      }
      this.threads.delete(oldest)
    }
  }
}
