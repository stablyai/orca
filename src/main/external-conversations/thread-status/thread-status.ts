// Orca's own status lines in a Slack bot thread (or DM) whose workers run on after the turn that
// started them: posted as new replies when the thread hears nothing for a while, never waking the
// bot. Kept on the thread's link, so a restart neither repeats nor forgets one.
import { cloudConversation } from '../../../shared/connectors/connector-cloud-contract'
import { slackMirrorAvailable } from '../../../shared/connectors/slack-mirror-state'
import type {
  ExternalConversationLink,
  ThreadStatusFact
} from '../../../shared/connectors/external-conversation-link'
import type { LeaveLinesCloud } from '../external-conversation-leave-lines'
import { writeLinkFact } from '../external-conversation-link-writes'
import {
  findLink,
  findLinkForPane,
  type ExternalConversationLinkStore
} from '../external-conversation-links'
import type {
  ConversationWorkersRead,
  ConversationWorkersWatcher,
  ConversationWorkerView
} from '../external-conversation-worker-view'
import { decideThreadStatus } from './thread-status-decide'
import {
  armedFact,
  armedLinks,
  disarmedFact,
  statusReplyId,
  withArmed,
  withBotLine,
  withHostLine,
  withoutPending
} from './thread-status-fact'
import { threadStatusHeld } from './thread-status-hold'
import { threadLinesOf } from './thread-status-lines'
import { sendThreadStatusLine } from './thread-status-send'

const TICK_MS = 60_000
// A line decided longer ago than this is dropped, never posted with a stale elapsed time.
const PENDING_MAX_MS = 10 * 60_000

type Thread = Pick<ExternalConversationLink, 'source' | 'externalId'>

export type ThreadStatusCloud = Pick<LeaveLinesCloud, 'cloudFeatures' | 'turnEndPending' | 'reply'>

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

export class ThreadStatus implements ConversationWorkersWatcher {
  private readonly views = new Map<string, ConversationWorkerView>()
  // Open prompts each armed conversation showed, by conversation id.
  private readonly prompts = new Map<string, Set<string>>()
  // Armed threads by id: the clock runs while there are any.
  private readonly armed = new Map<string, Thread>()
  // Threads deciding or sending a line: one at a time each.
  private readonly busy = new Set<string>()
  // Threads whose last line the cloud refused as a conflict: a second in a row stops them.
  private readonly conflicted = new Set<string>()
  private timer: { cancel: () => void } | null = null
  private readonly now: () => number

  constructor(private readonly deps: ThreadStatusDeps) {
    this.now = deps.now ?? Date.now
    // Lines a bot posts before the first watch still move an armed thread's clock.
    for (const { link } of armedLinks(deps.store)) {
      this.armed.set(idOf(link), link)
    }
  }

  applied(
    paneKey: string,
    view: ConversationWorkerView,
    reasons: ReadonlySet<ConversationWorkersRead>
  ): void {
    this.views.set(paneKey, view)
    const link = findLinkForPane(this.deps.store, paneKey)?.link
    if (!link) {
      return
    }
    const fact = link.threadStatus
    if (reasons.has('turn-ended') && fact?.armed) {
      this.write(link, { ...fact, armed: { ...fact.armed, turnEndAt: this.now() } })
    } else if (reasons.has('turn-ended') && view.open && this.eligible(link)) {
      this.write(link, armedFact(fact, this.now()))
    }
    void this.evaluate(link)
  }

  forgotten(paneKey: string): void {
    this.views.delete(paneKey)
  }

  cleared(): void {
    this.views.clear()
  }

  /** A watch began: armed threads are picked up again, and a line saved before a quit is sent. */
  watched(): void {
    for (const { link } of armedLinks(this.deps.store)) {
      this.armed.set(idOf(link), link)
      void this.evaluate(link)
    }
    this.schedule()
  }

  /** A connector call settled: the lines it put in armed threads move their clocks. */
  observed(path: string, body: unknown, result: { ok: boolean; value?: unknown }): void {
    if (this.armed.size === 0) {
      return
    }
    const notes = threadLinesOf(path, body, result)
    for (const conversation of notes.turnEnds) {
      this.prompts.delete(idOf(conversation))
    }
    for (const { conversation, promptId, open } of notes.prompts) {
      const id = idOf(conversation)
      if (open && this.armed.has(id)) {
        this.prompts.set(id, (this.prompts.get(id) ?? new Set()).add(promptId))
      } else if (!open) {
        this.prompts.get(id)?.delete(promptId)
      }
    }
    const at = this.now()
    for (const { conversation, kind, replyId } of notes.lines) {
      if (!this.armed.has(idOf(conversation))) {
        continue
      }
      if (kind === 'host') {
        this.hostLine(conversation, replyId, at)
        continue
      }
      const link = findLink(this.deps.store, conversation)?.link
      const fact = link?.threadStatus
      if (link && fact?.armed) {
        this.write(link, withBotLine({ ...fact, armed: fact.armed }, at))
      }
    }
  }

  // Told by both the observer and the sender; only the line still pending counts, so once.
  private hostLine(conversation: Thread, replyId: string | undefined, at: number): void {
    const link = findLink(this.deps.store, conversation)?.link
    const fact = link?.threadStatus
    if (!link || !fact?.armed || !replyId || fact.pending?.replyId !== replyId) {
      return
    }
    const posted = withHostLine({ ...fact, armed: fact.armed }, at)
    if (fact.pending.stop) {
      this.disarm(link, posted)
    } else {
      this.write(link, posted)
    }
  }

  private eligible(link: ExternalConversationLink): boolean {
    return (
      slackMirrorAvailable(link) &&
      !link.muted &&
      !link.mirrorBlocked &&
      !(link.bot && this.deps.botRefused?.(link.bot.botId))
    )
  }

  private async evaluate(thread: Thread): Promise<void> {
    const id = idOf(thread)
    if (this.busy.has(id)) {
      return
    }
    this.busy.add(id)
    try {
      await this.decideAndSend(thread)
    } finally {
      this.busy.delete(id)
    }
  }

  private async decideAndSend(thread: Thread): Promise<void> {
    const id = idOf(thread)
    const read = () => {
      const link = findLink(this.deps.store, thread)?.link
      const fact = link?.threadStatus
      return link && fact?.armed ? { link, fact, armed: fact.armed } : null
    }
    const found = read()
    if (!found) {
      this.armed.delete(id)
      return
    }
    this.armed.set(id, thread)
    this.schedule()
    const { link, fact } = found
    if (fact.pending && this.now() - fact.pending.at <= PENDING_MAX_MS) {
      return this.eligible(link) ? await this.send(link) : this.disarm(link, fact)
    }
    if (fact.pending) {
      this.write(link, withoutPending(fact))
    }
    const decide = (held: boolean) => {
      const current = read()
      const view = current ? this.views.get(current.link.paneKey) : undefined
      const eligible = !!current && this.eligible(current.link)
      const input = { now: this.now(), fact: current?.fact, view, held, eligible }
      return { current, decided: decideThreadStatus(input) }
    }
    const unheld = decide(false)
    if (unheld.decided.kind !== 'post') {
      return unheld.decided.kind === 'disarm' && unheld.current
        ? this.disarm(unheld.current.link, unheld.current.fact)
        : undefined
    }
    const view = this.views.get(link.paneKey)
    const promptOpen = (this.prompts.get(id)?.size ?? 0) > 0
    const held = await threadStatusHeld(
      this.deps,
      link,
      view?.lastTurnId ?? null,
      promptOpen,
      this.now()
    )
    // Read again after the wait: a line or a settle meanwhile decides afresh.
    const { current, decided } = decide(held)
    if (!current || current.fact.pending || decided.kind === 'wait') {
      return
    }
    if (decided.kind === 'disarm') {
      return this.disarm(current.link, current.fact)
    }
    const seq = current.fact.seq + 1
    const pending = {
      replyId: statusReplyId(current.link, seq),
      text: decided.text,
      at: this.now(),
      stop: decided.stop
    }
    this.write(current.link, { ...withArmed(current.fact, current.armed, { seq }), pending })
    await this.send(current.link)
  }

  private async send(given: ExternalConversationLink): Promise<void> {
    const cloud = this.deps.cloud()
    const conversation = cloudConversation(given)
    if (!cloud || cloud.cloudFeatures() === null || !conversation) {
      return
    }
    try {
      await this.deps.flush?.()
    } catch {
      // Not on disk yet: a restart could decide another line, so this one waits for its save.
      return
    }
    const link = findLink(this.deps.store, given)?.link
    const pending = link?.threadStatus?.pending
    if (!link || !pending || !link.threadStatus?.armed || !this.eligible(link)) {
      return
    }
    const owed = () => {
      const now = findLink(this.deps.store, given)?.link
      return !!now && this.eligible(now) && now.threadStatus?.pending?.replyId === pending.replyId
    }
    const sent = await sendThreadStatusLine(cloud, conversation, pending, owed)
    const id = idOf(link)
    if (sent === 'sent') {
      this.conflicted.delete(id)
      this.hostLine(link, pending.replyId, this.now())
      return
    }
    const current = findLink(this.deps.store, link)?.link
    const fact = current?.threadStatus
    if (sent === 'later' || !current || fact?.pending?.replyId !== pending.replyId) {
      return
    }
    if (sent === 'never') {
      console.warn('[connectors] stopped a thread’s status lines the cloud refused')
      return this.disarm(current, fact)
    }
    // A conflict drops the line; a second in a row stops the thread's lines.
    if (this.conflicted.delete(id)) {
      return this.disarm(current, fact)
    }
    this.conflicted.add(id)
    this.write(current, withoutPending(fact))
  }

  private disarm(link: ExternalConversationLink, fact: ThreadStatusFact): void {
    this.armed.delete(idOf(link))
    this.prompts.delete(idOf(link))
    this.write(link, disarmedFact(fact))
  }

  private write(link: Thread, threadStatus: ThreadStatusFact): void {
    try {
      writeLinkFact(this.deps.store, link, { threadStatus })
    } catch (error) {
      console.warn('[connectors] could not keep a thread’s status lines on its link', error)
    }
  }

  // One tick a minute while some thread is armed.
  private schedule(): void {
    if (this.timer || this.armed.size === 0) {
      return
    }
    const tick = () => {
      this.timer = null
      for (const thread of this.armed.values()) {
        void this.evaluate(thread)
      }
      this.schedule()
    }
    this.timer = this.deps.setTick
      ? this.deps.setTick(tick, TICK_MS)
      : unrefTimer(setTimeout(tick, TICK_MS))
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): { cancel: () => void } {
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function idOf(link: Thread): string {
  return JSON.stringify([link.source, link.externalId])
}
