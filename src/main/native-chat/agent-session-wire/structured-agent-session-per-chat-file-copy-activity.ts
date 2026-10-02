// The background copy takes no main-thread time while the chats work: while a send is in flight,
// or until 5 s after the last provider frame any chat received (structured-agent-session-chat-
// activity.ts says why frames). It starts no chat then, and a chat whose copy is under way when a
// frame arrives stops at its next batch, publishing nothing and staying owed. A turn that is
// running but silent, or parked on a prompt, holds nothing: the main thread is idle for it.

import type { StructuredAgentSessionChatWork } from './structured-agent-session-chat-activity'

/** How long after the last frame the copy waits: past the gaps inside a streaming answer and the
 *  moments after a turn when a user reads it and sends again, short enough that an idle host soon
 *  resumes. */
export const PER_CHAT_FILE_COPY_QUIET_MS = 5_000

/** One chat's copy: its signal stops it at quit, or the moment a provider frame arrives. */
export type PerChatFileCopyChat = {
  signal: AbortSignal
  /** Stopped because a chat worked, not for quit: no failure, and still owed. */
  stoppedByWork: () => boolean
  release: () => void
}

export class StructuredAgentSessionPerChatFileCopyActivity {
  /** When the job last saw a provider frame. */
  private lastWorkAt = Number.NEGATIVE_INFINITY
  private chat: AbortController | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly deps: { chatWork: StructuredAgentSessionChatWork; now: () => number }
  ) {
    this.unsubscribe = deps.chatWork.onActivity(() => {
      this.lastWorkAt = deps.now()
      this.chat?.abort()
    })
  }

  /** No send in flight, and no frame for the quiet period: re-derived at every call. */
  quiet(): boolean {
    return (
      !this.deps.chatWork.sendInFlight() &&
      this.deps.now() - this.lastWorkAt >= PER_CHAT_FILE_COPY_QUIET_MS
    )
  }

  forChat(quit: AbortSignal): PerChatFileCopyChat {
    const work = new AbortController()
    this.chat = work
    // Work that started since the gate let this chat through.
    if (!this.quiet()) {
      work.abort()
    }
    return {
      signal: AbortSignal.any([quit, work.signal]),
      stoppedByWork: () => work.signal.aborted && !quit.aborted,
      release: () => {
        if (this.chat === work) {
          this.chat = null
        }
      }
    }
  }

  dispose(): void {
    this.unsubscribe()
  }
}
