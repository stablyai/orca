// Orca's own status lines in a Slack bot thread (or DM) whose workers run on after the turn that
// started them: posted as new replies when the thread hears nothing for a while, never waking the
// bot. Kept on the thread's link, so a restart neither repeats nor forgets one.
import { cloudConversation } from '../../../shared/connectors/connector-cloud-contract'
import type {
  ExternalConversationLink,
  ThreadStatusFact
} from '../../../shared/connectors/external-conversation-link'
import { findLink, findLinkForPane } from '../external-conversation-links'
import type {
  ConversationWorkersRead,
  ConversationWorkersWatcher,
  ConversationWorkerView
} from '../external-conversation-worker-view'
import { decideThreadStatus, mayArm } from './thread-status-decide'
import {
  armedFact,
  armedLinks,
  disarmedFact,
  statusReplyId,
  withArmed,
  withBotLine,
  withHostLine,
  withoutPending,
  withoutSavedLine,
  withTurnEnd,
  writeThreadStatus
} from './thread-status-fact'
import { answerReadKey, threadStatusAnswerHeld, threadStatusHeldNow } from './thread-status-hold'
import { threadLinesOf } from './thread-status-lines'
import { savedLineNow, type SavedLineNow } from './thread-status-owed'
import { sendThreadStatusLine } from './thread-status-send'
import { ThreadStatusWaits } from './thread-status-waits'
import {
  idOf,
  threadStatusEligible,
  ThreadStatusTicks,
  type ThreadStatusDeps
} from './thread-status-deps'

export type { ThreadStatusCloud, ThreadStatusDeps } from './thread-status-deps'

type Thread = Pick<ExternalConversationLink, 'source' | 'externalId'>

export class ThreadStatus implements ConversationWorkersWatcher {
  private readonly views = new Map<string, ConversationWorkerView>()
  // Armed threads by id: the clock runs while there are any.
  private readonly armed = new Map<string, Thread>()
  // Threads deciding or sending a line: one at a time each, and again once done when asked meanwhile.
  private readonly busy = new Set<string>()
  private readonly again = new Set<string>()
  // Threads whose last line the cloud refused as a conflict: a second in a row stops them.
  private readonly conflicted = new Set<string>()
  // When the cloud said a thread's line may go again, by thread id.
  private readonly notBefore = new Map<string, number>()
  private readonly waits: ThreadStatusWaits
  // One tick a minute while some thread is armed.
  private readonly ticks: ThreadStatusTicks
  private readonly write = (link: Thread, fact: ThreadStatusFact) =>
    writeThreadStatus(this.deps.store, link, fact)
  private readonly now: () => number

  constructor(private readonly deps: ThreadStatusDeps) {
    this.now = deps.now ?? Date.now
    this.waits = new ThreadStatusWaits(this.now)
    const armed = () => [...this.armed.values()]
    this.ticks = new ThreadStatusTicks(deps.setTick, armed, (thread) => this.evaluate(thread))
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
    if (!reasons.has('turn-ended')) {
      void this.evaluate(link)
      return
    }
    // A turn end's answer is still on its way to the thread: the next tick decides, never this read.
    if (fact?.armed) {
      this.write(link, withTurnEnd({ ...fact, armed: fact.armed }, this.now()))
    } else if (view.open && threadStatusEligible(this.deps, link) && mayArm(fact, this.now())) {
      this.write(link, armedFact(fact, this.now()))
    }
    if (findLink(this.deps.store, link)?.link.threadStatus?.armed) {
      this.armed.set(idOf(link), link)
      this.ticks.start()
    }
  }

  forgotten(paneKey: string): void {
    this.views.delete(paneKey)
    this.waits.forgetPane(paneKey)
  }

  /** Told as the turn ends, before its answer is read: no line goes until that answer could. */
  turnEnding(paneKey: string): void {
    this.waits.turnEnding(paneKey)
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
    this.ticks.start()
  }

  /** A connector call settled: the lines it put in armed threads move their clocks. */
  observed(path: string, body: unknown, result: { ok: boolean; value?: unknown }): void {
    if (this.armed.size === 0) {
      return
    }
    const notes = threadLinesOf(path, body, result)
    this.waits.noted(notes, (id) => this.armed.has(id))
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
    return fact.pending.stop ? this.disarm(link, posted) : this.write(link, posted)
  }

  private async evaluate(thread: Thread): Promise<void> {
    const id = idOf(thread)
    if (this.busy.has(id)) {
      // A read or line meanwhile is decided as soon as this one is done, not a tick later.
      this.again.add(id)
      return
    }
    this.busy.add(id)
    try {
      await this.decideAndSend(thread)
    } catch (error) {
      console.warn('[connectors] could not post a thread’s status line', error)
    } finally {
      this.busy.delete(id)
    }
    if (this.again.delete(id)) {
      await this.evaluate(thread)
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
      this.forget(id)
      return
    }
    this.armed.set(id, thread)
    this.ticks.start()
    if ((this.notBefore.get(id) ?? 0) > this.now()) {
      return
    }
    const decide = (held: (link: ExternalConversationLink) => boolean) => {
      const current = read()
      const view = current ? this.views.get(current.link.paneKey) : undefined
      const eligible = !!current && threadStatusEligible(this.deps, current.link)
      const pendingMayHavePosted = this.waits.mayHavePosted(id, current?.fact.pending?.replyId)
      const input = { now: this.now(), fact: current?.fact, view, eligible, pendingMayHavePosted }
      return {
        current,
        decided: decideThreadStatus({ ...input, held: !!current && held(current.link) })
      }
    }
    // A saved line goes again only as a new one would: unheld, still due and still the same line.
    const unheld = decide(() => false)
    if (unheld.decided.kind === 'disarm' && unheld.current) {
      return this.disarm(unheld.current.link, unheld.current.fact)
    }
    if (unheld.decided.kind !== 'post' || this.heldNow(found.link)) {
      return
    }
    const { link } = found
    const lastTurnId = this.views.get(link.paneKey)?.lastTurnId ?? null
    const readAt = this.now()
    const answerHeld = await threadStatusAnswerHeld(this.deps, link, lastTurnId)
    // A read for a turn the pane has since moved past says nothing: the next tick reads again.
    const after = read()?.link
    const fresh = !!after && this.answerKey(after) === answerReadKey(link, lastTurnId)
    this.waits.answerRead(id, fresh && !answerHeld ? this.answerKey(link) : null, readAt)
    // Read again after the wait, on the link as it is now: a turn, a line or a settle decides afresh.
    const { current, decided } = decide((now) => answerHeld || this.heldNow(now))
    if (!fresh || !current || decided.kind === 'wait') {
      return
    }
    if (decided.kind === 'disarm') {
      return this.disarm(current.link, current.fact)
    }
    const saved = current.fact.pending ? this.settleSaved(current.link) : 'drop'
    // A dropped line that may have posted counts as one, so the next tick decides on the fact as is.
    if (saved !== 'drop' || this.waits.mayHavePosted(id, current.fact.pending?.replyId)) {
      return saved === 'send' ? await this.send(current.link) : undefined
    }
    const seq = current.fact.seq + 1
    const pending = {
      replyId: statusReplyId(current.link, current.armed.at, seq),
      text: decided.text,
      at: this.now(),
      stop: decided.stop
    }
    this.write(current.link, { ...withArmed(current.fact, current.armed, { seq }), pending })
    // Marked unsent only once on the link: a failed write leaves the line before it as it was.
    if (read()?.fact.pending?.replyId === pending.replyId) {
      this.waits.saved(id, pending.replyId)
    }
    await this.send(current.link)
  }

  private async send(given: ExternalConversationLink): Promise<void> {
    try {
      await this.deps.flush?.()
    } catch {
      // Not on disk yet: a restart could decide another line, so this one waits for its save.
      return
    }
    // Asked again after the save, with nothing awaited between this and the post.
    const cloud = this.deps.cloud()
    const link = findLink(this.deps.store, given)?.link
    const pending = link?.threadStatus?.pending
    const conversation = link && cloudConversation(link)
    if (!cloud || !link || !pending || !conversation || this.settleSaved(link) !== 'send') {
      return
    }
    const id = idOf(link)
    // An earlier try may already have posted it: a refusal or conflict now speaks only for this one.
    const triedBefore = this.waits.mayHavePosted(id, pending.replyId)
    // From here the cloud may take it even if no answer comes back.
    this.waits.sending(id)
    // One try: the next tick sends it again under the same id once every check passes again.
    const sent = await sendThreadStatusLine(cloud, conversation, pending, () => false)
    this.notBefore.delete(id)
    if (sent.kind === 'later' && sent.retryAfterMs) {
      this.notBefore.set(id, this.now() + sent.retryAfterMs)
    }
    if (sent.kind === 'sent') {
      this.conflicted.delete(id)
      return this.hostLine(link, pending.replyId, this.now())
    }
    const current = findLink(this.deps.store, link)?.link
    const after = current?.threadStatus
    if (!current || after?.pending?.replyId !== pending.replyId) {
      return
    }
    if (sent.kind === 'later') {
      return void this.settleSaved(current)
    }
    // A refusal stops the thread's lines; a conflict drops the line, and a second in a row stops them.
    const dropped = triedBefore ? withoutSavedLine(after, this.now(), true) : withoutPending(after)
    if (sent.kind === 'never' || this.conflicted.has(id) || !dropped.armed) {
      return this.disarm(current, dropped)
    }
    this.conflicted.add(id)
    this.write(current, dropped)
  }

  /** What the saved line comes to now, by all that is known without waiting; a line no longer
   *  owed is dropped, or its run stopped, at once rather than a tick later. */
  private settleSaved(link: ExternalConversationLink): SavedLineNow {
    const fact = link.threadStatus
    const mayHavePosted = this.waits.mayHavePosted(idOf(link), fact?.pending?.replyId)
    const verdict = savedLineNow({
      now: this.now(),
      fact,
      view: this.views.get(link.paneKey),
      eligible: threadStatusEligible(this.deps, link),
      held: this.heldNow(link),
      answerClear: this.waits.answerClearFor(idOf(link), this.answerKey(link), link.paneKey),
      cloudReady: (this.deps.cloud()?.cloudFeatures() ?? null) !== null,
      mayHavePosted
    })
    const dropped =
      fact && verdict === 'drop' ? withoutSavedLine(fact, this.now(), mayHavePosted) : undefined
    if (fact && (verdict === 'disarm' || (dropped && !dropped.armed))) {
      this.disarm(link, dropped ?? fact)
    } else if (dropped) {
      this.write(link, dropped)
    }
    return verdict
  }

  private answerKey(link: ExternalConversationLink): string {
    return answerReadKey(link, this.views.get(link.paneKey)?.lastTurnId ?? null)
  }

  private heldNow(link: ExternalConversationLink): boolean {
    const lastTurnId = this.views.get(link.paneKey)?.lastTurnId ?? null
    return threadStatusHeldNow(this.deps, this.waits, link, lastTurnId, this.now())
  }

  /** A saved line that may have posted counts for the day, so a later run keeps to the cap. */
  private disarm(link: ExternalConversationLink, fact: ThreadStatusFact): void {
    const id = idOf(link)
    const mayHavePosted = this.waits.mayHavePosted(id, fact.pending?.replyId)
    this.forget(id)
    this.write(link, disarmedFact(withoutSavedLine(fact, this.now(), mayHavePosted)))
  }

  // What this process kept for one thread's run; a later run starts clean.
  private forget(id: string): void {
    this.armed.delete(id)
    this.waits.forgetThread(id)
    this.notBefore.delete(id)
    this.conflicted.delete(id)
  }
}
