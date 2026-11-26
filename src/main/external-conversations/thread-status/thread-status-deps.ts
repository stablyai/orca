// What the thread status lines reach: the link store, the cloud, the reply outbox and the clock.
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import type { LeaveLinesCloud } from '../external-conversation-leave-lines'
import type { ExternalConversationLinkStore } from '../external-conversation-links'

type Thread = Pick<ExternalConversationLink, 'source' | 'externalId'>

export type ThreadStatusCloud = Pick<LeaveLinesCloud, 'cloudFeatures' | 'turnEndPending'> & {
  /** As leave lines post; a refusal may say when to try again. */
  reply: (
    ...args: Parameters<LeaveLinesCloud['reply']>
  ) => Promise<
    | { ok: true }
    | { ok: false; status: number | null; error: string | null; retryAfterMs?: number | null }
  > | null
}

export type ThreadStatusDeps = {
  store: ExternalConversationLinkStore
  /** Null while no client runs: lines wait. */
  cloud: () => ThreadStatusCloud | null
  /** Saves pending store writes to disk; a line is saved before it is sent. */
  flush?: () => Promise<void>
  /** Whether the reply outbox still holds `turnId`'s answer in the thread. Rejects when it can't tell. */
  answerPending?: (
    link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
    turnId: number
  ) => Promise<boolean>
  /** The pane's running turn (its id is its start), null when none runs. */
  runningTurn: (paneKey: string) => number | null
  /** The bot is paused or gone. */
  botRefused?: (botId: string) => boolean
  now?: () => number
  setTick?: (run: () => void, ms: number) => { cancel: () => void }
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): { cancel: () => void } {
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function idOf(link: Thread): string {
  return JSON.stringify([link.source, link.externalId])
}
