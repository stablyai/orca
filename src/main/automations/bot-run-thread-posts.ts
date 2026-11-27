// Where a live bot run's final message goes, as the dispatcher routed this run: `bot reply` posts
// into the thread it posts into from an unlinked conversation, and a refused reply names its place,
// never where the saved automation would send another run. In memory: after a restart a reply is
// refused with the saved automation's place, rather than guessing a thread.
import type { ConversationKey } from '../external-conversations/external-conversation-types'

export type RunRoute = {
  botId: string
  /** The thread it posts its result into from its own conversation, and that thread as people
   *  name it. */
  threadPost?: { conversation: ConversationKey; place: string }
  /** "Your final message …", as the run's wake note says it. */
  sentence: string
}

const live = new Map<string, RunRoute>()

export const runRoutes = {
  /** Returns the release, which forgets only this run's own entry. */
  start(sessionId: string, route: RunRoute): () => void {
    live.set(sessionId, route)
    return () => {
      if (live.get(sessionId) === route) {
        live.delete(sessionId)
      }
    }
  },
  of(sessionId: string): RunRoute | undefined {
    return live.get(sessionId)
  }
}
