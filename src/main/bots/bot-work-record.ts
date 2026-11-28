// A bot's work record: which worker each conversation's code work went to, checked against
// orchestration on every use. A row closes only on proof; anything unknown keeps it.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { ownPullRequest } from './bot-work-pr-match'
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'
import type { BotWorkAddress, BotWorkHost, BotWorkRow } from './bot-work-store'
import { botWorkTurnNote, cleanBotWorkText } from './bot-work-turn-note'
import { readBotWorkRows } from './bot-work-row-read'
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

  /** A worker a bot's turn started becomes its conversation's (or chat's) current row: the newest work wins the
   *  thread's follow-ups, and the row it replaces stays live for its PR. A follow-up of any of the
   *  conversation's workers records nothing. */
  async started(
    turn: BotTurnAddress,
    start: { taskId: string; dispatchId: string; host: BotWorkHost }
  ): Promise<void> {
    const bind = { ...turn, ...start }
    const store = this.deps.store()
    const rows = await store.addressRows(turn.botId, turn.address)
    if (rows.some((row) => row.dispatchId === start.dispatchId)) {
      return
    }
    const workers =
      rows.length > 0
        ? await this.deps.workers(rows.map((row) => row.dispatchId)).catch(() => null)
        : null
    if (rows.some((row) => workers?.get(row.dispatchId)?.dispatchId === start.dispatchId)) {
      return
    }
    // One transaction in the worker: starts and closes landing meanwhile are each seen in turn.
    await store.makeCurrent(bind)
  }

  /** Validates a live row, closing it on proof; null once it is closed, by this or anyone. */
  async check(row: BotWorkRow): Promise<BotWorkCheck | null> {
    for await (const checked of this.checkAll([row])) {
      return checked
    }
    return null
  }

  /** Validates live rows with one worker read per host, closing each on proof; yields those still live. */
  async *checkAll(rows: readonly BotWorkRow[]): AsyncGenerator<BotWorkCheck> {
    for await (const read of readBotWorkRows(this.deps, rows)) {
      if ('closeReason' in read) {
        // A failed close leaves the row live for the next read; the other rows still count.
        await this.deps
          .store()
          .close(read.row, read.closeReason)
          .catch(() => {})
      } else if (await this.deps.store().isOpen(read.row)) {
        // The reads await, and a close may have landed meanwhile.
        yield read
      }
    }
  }

  /** What a turn from a conversation with live work is told: which worker to send follow-ups to. */
  async turnNote(
    sessionId: string,
    message: Pick<AgentJournalMessageItem, 'origin'>
  ): Promise<string | null> {
    this.handedOver(sessionId, message)
    const turn = await this.turnOf(sessionId)
    const read = async () => {
      const live = turn && (await this.deps.store().live(turn.botId, turn.address))
      return live ? this.check(live) : null
    }
    // The store's read is within the wait too: a stalled worker never holds the turn back.
    const checked = turn && (await withTimeout(read(), BOT_WORK_NOTE_TIMEOUT_MS, null))
    return checked ? botWorkTurnNote(checked) : null
  }

  /** The work a bot started that is still its conversations', newest first. */
  async list(botId: string): Promise<BotWorkerSummary[]> {
    const items: BotWorkerSummary[] = []
    for await (const { row, worker, workspace } of this.checkAll(
      await this.deps.store().liveRows(botId)
    )) {
      // A chat's own name; a connector conversation's only when its connector asked.
      const linked =
        row.askedInApp && row.address.source !== 'chat'
          ? null
          : this.deps.conversationTitle(row.address)
      const title = linked ? cleanBotWorkText(linked) : null
      items.push({
        id: row.rowId,
        title: cleanBotWorkText(worker?.title ?? `dispatch:${row.dispatchId}`),
        agent: worker?.agent ?? null,
        state: worker?.state ?? null,
        ...(worker?.idle ? { idle: true } : {}),
        ...(worker?.state === 'working' && worker.progressNote
          ? { progressNote: cleanBotWorkText(worker.progressNote) }
          : {}),
        dispatchId: worker?.dispatchId ?? row.dispatchId,
        workspace: workspace ? cleanBotWorkText(workspace.name) : null,
        server: worker?.hostName ? cleanBotWorkText(worker.hostName) : null,
        pr: workspace ? ownPullRequest(workspace) : null,
        startedAt: worker?.startedAt ?? null,
        source: {
          source: row.askedInApp || row.address.source === 'chat' ? 'app' : row.address.source,
          title
        }
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
      for await (const { workspace } of this.checkAll(
        await this.deps.store().addressRows(botId, address)
      )) {
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
    const rows = turn ? await store.addressRows(turn.botId, turn.address) : []
    const closed = await Promise.all(rows.map((row) => store.close(row, 'owner_reset')))
    return closed.some(Boolean)
  }

  /** A deleted bot's rows; never rejects, so its caller needn't wait. Rows a failure leaves open
   *  name a bot no lookup lists, so nothing reads them. */
  async forgetBot(botId: string): Promise<void> {
    try {
      const store = this.deps.store()
      for (const row of await store.liveRows(botId)) {
        await store.close(row, 'bot_gone')
      }
    } catch (error) {
      console.warn('[bots] closing a deleted bot work failed', error)
    }
  }
}
