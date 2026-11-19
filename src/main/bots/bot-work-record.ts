// A bot's work record: which worker each conversation's code work went to, checked against
// orchestration on every use. A row closes only on proof; anything unknown keeps it.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { ownPullRequest } from './bot-work-pr-match'
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'
import type {
  BotWorkAddress,
  BotWorkCloseReason,
  BotWorkHost,
  BotWorkRef,
  BotWorkRow,
  BotWorkStore
} from './bot-work-store'
import { botWorkTurnNote, cleanBotWorkText } from './bot-work-turn-note'
import { readBotWorkRow } from './bot-work-row-read'
import type { BotTurnAddress, BotWorkCheck, BotWorkRecordDeps } from './bot-work-types'

export type {
  BotTurnAddress,
  BotWorkCheck,
  BotWorkRecordDeps,
  BotWorkWorker,
  BotWorkWorkspace
} from './bot-work-types'

// A stalled host never holds a message back: past this, the turn goes without a note.
export const BOT_WORK_NOTE_TIMEOUT_MS = 1_500

export class BotWorkRecord {
  // Each session's current turn, as its handover named it; cleared when the turn ends.
  private readonly turns = new Map<string, Promise<BotTurnAddress | null>>()

  constructor(private readonly deps: BotWorkRecordDeps) {}

  /** A person's message started a turn, with or without attachments: it names the turn's
   *  conversation. */
  handedOver(sessionId: string, message: Pick<AgentJournalMessageItem, 'origin'>): void {
    this.turns.set(
      sessionId,
      this.deps.turnAddress(sessionId, message).catch(() => null)
    )
  }

  /** The conversation a session's current turn came from, as its handover named it; null for a turn
   *  no person's message handed over (an automation run). A wrong conversation is worse than none. */
  turnOf(sessionId: string): Promise<BotTurnAddress | null> {
    return this.turns.get(sessionId) ?? Promise.resolve(null)
  }

  /** A turn ended; the next one names its own conversation. */
  turnEnded(sessionId: string): void {
    this.turns.delete(sessionId)
  }

  /** A worker a bot's turn started becomes its conversation's current row: the newest work wins the
   *  thread's follow-ups, and the row it replaces stays live for its PR. A follow-up of any of the
   *  conversation's workers records nothing. */
  async started(
    turn: BotTurnAddress,
    start: { taskId: string; dispatchId: string; host: BotWorkHost }
  ): Promise<void> {
    const bind = { ...turn, ...start }
    const store = this.deps.store()
    const rows = store.addressRows(turn.botId, turn.address)
    for (const row of rows) {
      const latest =
        row.dispatchId === start.dispatchId
          ? start.dispatchId
          : (await this.deps.worker(row.dispatchId).catch(() => null))?.dispatchId
      if (latest === start.dispatchId) {
        return
      }
    }
    // Another start, or a close, may land during the reads; storage then refuses this write, and
    // one more try against what is there now makes this, the newest, current.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = store.live(turn.botId, turn.address)
      if (current?.dispatchId === start.dispatchId) {
        return
      }
      if (current ? store.replace(current, bind) : store.bind(bind)) {
        return
      }
    }
  }

  /** Validates a live row, closing it on proof; null once it is closed, by this or anyone. */
  async check(row: BotWorkRow): Promise<BotWorkCheck | null> {
    const read = await readBotWorkRow(this.deps, row)
    if ('closeReason' in read) {
      this.deps.store().close(row, read.closeReason)
      return null
    }
    // The reads await, and a close may have landed meanwhile.
    return this.isLive(row) ? read : null
  }

  /** What a turn from a conversation with live work is told: which worker to send follow-ups to. */
  async turnNote(
    sessionId: string,
    message: Pick<AgentJournalMessageItem, 'origin'>
  ): Promise<string | null> {
    this.handedOver(sessionId, message)
    const turn = await this.turnOf(sessionId)
    const live = turn && this.deps.store().live(turn.botId, turn.address)
    const checked = live && (await withTimeout(this.check(live), BOT_WORK_NOTE_TIMEOUT_MS, null))
    return checked ? botWorkTurnNote(checked) : null
  }

  /** The work a bot started that is still its conversations', newest first. */
  async list(botId: string): Promise<BotWorkerSummary[]> {
    const items: BotWorkerSummary[] = []
    for (const row of this.deps.store().liveRows(botId)) {
      const checked = await this.check(row)
      if (!checked) {
        continue
      }
      const { worker, workspace } = checked
      const linked = row.askedInApp ? null : this.deps.conversationTitle(row.address)
      const title = linked ? cleanBotWorkText(linked) : null
      items.push({
        id: row.rowId,
        title: cleanBotWorkText(worker?.title ?? `dispatch:${row.dispatchId}`),
        agent: worker?.agent ?? null,
        state: worker?.state ?? null,
        ...(worker?.idle ? { idle: true } : {}),
        dispatchId: worker?.dispatchId ?? row.dispatchId,
        workspace: workspace ? cleanBotWorkText(workspace.name) : null,
        server: worker?.hostName ? cleanBotWorkText(worker.hostName) : null,
        pr: workspace ? ownPullRequest(workspace) : null,
        startedAt: worker?.startedAt ?? null,
        source: { source: row.askedInApp ? 'app' : row.address.source, title }
      })
    }
    return items
  }

  /** The pull requests a conversation's live work opened, as its workspaces' rows show them; read
   *  within the note's wait, so a turn's end never waits long on a host. */
  async pullRequests(
    botId: string,
    address: BotWorkAddress,
    max: number
  ): Promise<BotWorkPullRequest[]> {
    const found: BotWorkPullRequest[] = []
    const read = async () => {
      for (const row of this.deps.store().addressRows(botId, address)) {
        const workspace = (await this.check(row))?.workspace
        const pr = workspace && ownPullRequest(workspace)
        if (pr && found.length < max) {
          found.push(pr)
        }
      }
    }
    await withTimeout(read(), BOT_WORK_NOTE_TIMEOUT_MS, undefined)
    return [...found]
  }

  /** The owner said to forget this conversation's work, superseded rows too: its next request
   *  starts fresh. */
  async forget(sessionId: string): Promise<boolean> {
    const turn = await this.turnOf(sessionId)
    const store = this.deps.store()
    const rows = turn ? store.addressRows(turn.botId, turn.address) : []
    return rows.filter((row) => store.close(row, 'owner_reset')).length > 0
  }

  close(ref: BotWorkRef, reason: BotWorkCloseReason): boolean {
    return this.deps.store().close(ref, reason)
  }

  /** This profile's store; read only by the inert PR waker connector-cloud-install.ts still builds. */
  store(): BotWorkStore {
    return this.deps.store()
  }

  /** A deleted bot's rows. */
  forgetBot(botId: string): void {
    const store = this.deps.store()
    for (const row of store.liveRows(botId)) {
      store.close(row, 'bot_gone')
    }
  }

  private isLive(row: BotWorkRow): boolean {
    return this.deps.store().isOpen(row)
  }
}
