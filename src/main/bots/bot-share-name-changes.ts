// The one signal that a teammate Home's title changed: a share resolved, was renamed, removed or
// declined, or a Home moved to another chat. Every cache built from the titles listens to it.
import type { Bot } from '../../shared/bot-types'
import { teammateHomeTitlesBySession } from '../runtime/agent-session/records/agent-session-record-home-names'

/** `sessionIds`: the chats whose title changed, or that started or stopped being a teammate's Home. */
export type ShareNamesChange = { bot: Bot; sessionIds: string[] }

export class BotShareNameChanges {
  private readonly listeners = new Set<(change: ShareNamesChange) => void>()

  listen(listener: (change: ShareNamesChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** After `after` was saved over `before`. */
  saved(before: Bot, after: Bot): void {
    const was = teammateHomeTitlesBySession(before)
    const now = teammateHomeTitlesBySession(after)
    const sessionIds = [...new Set([...was.keys(), ...now.keys()])].filter(
      (sessionId) => was.get(sessionId) !== now.get(sessionId)
    )
    if (sessionIds.length === 0) {
      return
    }
    for (const listener of this.listeners) {
      try {
        listener({ bot: after, sessionIds })
      } catch (error) {
        console.warn('[bots] a share name change was not applied:', error)
      }
    }
  }
}
