// What the thread status lines reach: the link store, the cloud, the reply outbox and the clock.
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import { slackMirrorAvailable } from '../../../shared/connectors/slack-mirror-state'
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

/** A Slack bot thread or DM that isn't muted, blocked or its bot's refused. */
export function threadStatusEligible(
  deps: Pick<ThreadStatusDeps, 'botRefused'>,
  link: ExternalConversationLink
): boolean {
  return (
    slackMirrorAvailable(link) &&
    !link.muted &&
    !link.mirrorBlocked &&
    !(link.bot && deps.botRefused?.(link.bot.botId))
  )
}

const TICK_MS = 60_000

/** One tick a minute while some thread is armed; each tick evaluates every armed thread. */
export class ThreadStatusTicks {
  private timer: { cancel: () => void } | null = null

  constructor(
    private readonly setTick: ThreadStatusDeps['setTick'],
    private readonly armed: () => readonly Thread[],
    private readonly evaluate: (thread: Thread) => Promise<void>
  ) {}

  start(): void {
    if (this.timer || this.armed().length === 0) {
      return
    }
    const tick = () => {
      this.timer = null
      for (const thread of this.armed()) {
        void this.evaluate(thread)
      }
      this.start()
    }
    this.timer = this.setTick ? this.setTick(tick, TICK_MS) : unrefTimer(setTimeout(tick, TICK_MS))
  }
}
