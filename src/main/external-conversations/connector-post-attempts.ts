// When each chat, by its pane key, tried to post into the thread it answers itself (`orca bot
// reply`, or a connector post or attach there), noted before the cloud call: an empty turn that
// tried is never retried, and its words before its last tool aren't its answer, whether the post
// landed or may have landed. One the cloud refused outright is taken back. Memory only: after a
// restart no live turn end retries anything.

// Chats kept; past this many, the longest idle goes first. Each keeps its newest posts only.
const MAX_CHATS = 1000
const MAX_ATTEMPTS = 32

export class ConnectorPostAttempts {
  /** Per chat, each post (by its id; a check of a queued post sends the same one): when it was first
   *  tried, and the thread (external id) it went to. */
  private readonly attempts = new Map<string, Map<unknown, { at: number; conversation?: string }>>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Notes an attempt at post `postId`; the returned call takes that post back when it was refused
   *  outright. */
  attempted(paneKey: string, postId?: string, conversation?: string): () => void {
    const key = postId ?? {}
    const chat =
      this.attempts.get(paneKey) ?? new Map<unknown, { at: number; conversation?: string }>()
    this.attempts.delete(paneKey)
    this.attempts.set(paneKey, chat)
    if (!chat.has(key)) {
      chat.set(key, { at: this.now(), ...(conversation === undefined ? {} : { conversation }) })
    }
    if (chat.size > MAX_ATTEMPTS) {
      chat.delete(chat.keys().next().value)
    }
    if (this.attempts.size > MAX_CHATS) {
      this.attempts.delete(this.attempts.keys().next().value!)
    }
    return () => {
      chat.delete(key)
    }
  }

  /** Whether the chat tried a post, not taken back, from `at` to `until` (its turn's start and end),
   *  into `conversation` when named (a post whose thread isn't known counts for any). */
  since(
    paneKey: string,
    at: number,
    until = Number.POSITIVE_INFINITY,
    conversation?: string
  ): boolean {
    for (const tried of this.attempts.get(paneKey)?.values() ?? []) {
      const there =
        conversation === undefined ||
        tried.conversation === undefined ||
        tried.conversation === conversation
      if (there && tried.at >= at && tried.at <= until) {
        return true
      }
    }
    return false
  }
}

/** The running app's record: the post paths note into it, the reply fill reads it. */
export const connectorPostAttempts = new ConnectorPostAttempts()
