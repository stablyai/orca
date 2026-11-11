import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalStatusItem, JournalStatusItemSelection } from './journal-status-items'
import { sqlJournalStatusItems } from './journal-sql-status-items'
import { sqlFailedStatusItems, sqlHasStatusRequestItem } from './journal-sql-status-request-items'
import { sqlStatusRelatedInputIds } from './journal-sql-status-inputs'
import {
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  journalDomainDisplayTurnState
} from './journal-domain-item-display'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import {
  journalDomainInputForItem,
  journalDomainInputOrdinal,
  journalDomainLatestSteer,
  journalDomainRecoverableSubmissions,
  journalDomainStatusInputAfter,
  journalDomainStatusInputs,
  journalDomainSubmission
} from './journal-domain-status-inputs'

/** Decoded current rows and winning seeds live only for this caller's ready SQL snapshot. */
export class JournalSqlStatusContext {
  private readonly selected = new Map<string, JournalStatusItem[]>()
  private readonly items = new Map<
    string,
    | { item: AgentJournalRenderItem; displayJson: unknown; hidden: boolean; fence: number }
    | undefined
  >()
  private readonly submissions = new Map<string, AgentJournalSubmission | undefined>()
  private readonly ordinals = new Map<string, number>()
  private readonly seeds = new Map<number | undefined, AgentJournalSubmission[]>()
  readonly epoch: string
  readonly sequence: number
  readonly lastActivityAt: number
  private recoverable: AgentJournalSubmission[] | undefined
  readonly submissionCount: number
  readonly stop: JournalLatestStop | null

  constructor(readonly scope: JournalSqlScope) {
    const row = scope.db
      .prepare(`SELECT context_boundary,last_sequence,last_activity_at,queue_latest_stop_json,
      (SELECT COALESCE(MAX(ordinal),-1)+1 FROM journal_submission_attempts
       WHERE session_id=? AND epoch=?) AS submission_count
      FROM journal_chat_state WHERE session_id=? AND epoch=?`)
      .get(...scope.prefix, ...scope.prefix)
    if (!row) {
      throw new Error('journal status read targets a retired chat epoch')
    }
    scope.examined(row)
    this.epoch = journalContextEpoch(scope.epoch, Number(row.context_boundary))
    this.sequence = Number(row.last_sequence)
    this.lastActivityAt = Number(row.last_activity_at)
    this.submissionCount = Number(row.submission_count)
    this.stop =
      row.queue_latest_stop_json === null
        ? null
        : scope.decode<JournalLatestStop>(row.queue_latest_stop_json)
  }

  private current(id: string) {
    if (!this.items.has(id)) {
      const row = this.scope.db
        .prepare(`SELECT payload_json,wire_version,wire_json,
        hidden,COALESCE(execution_owner,owner_fence) AS fence
        FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
        .get(...this.scope.prefix, id)
      if (row) {
        this.scope.examined(row)
        const source = this.scope.decode<AgentJournalRenderItem>(row.payload_json)
        const states = readJournalDomainStopStates(this.scope.db, this.scope, [id])
        const displayed = resolveJournalDomainDisplay(
          source,
          row.wire_version,
          row.wire_json,
          journalDomainDisplayTurnState(source, states)
        )
        row.display_json = displayed === source ? row.payload_json : JSON.stringify(displayed)
      }

      this.items.set(
        id,
        row
          ? {
              item: this.scope.decode<AgentJournalRenderItem>(row.payload_json),
              displayJson: row.display_json === row.payload_json ? null : row.display_json,
              hidden: Boolean(row.hidden),
              fence: Number(row.fence)
            }
          : undefined
      )
    }
    return this.items.get(id)
  }

  item = (id: string) => this.current(id)?.item

  /** Semantic display uses the writer's saved Stop rewrite without shortening ordinary items. */
  displayed = (id: string): AgentJournalRenderItem | null => {
    const row = this.current(id)
    return row && !row.hidden
      ? row.displayJson === null
        ? row.item
        : this.scope.decode<AgentJournalRenderItem>(row.displayJson)
      : null
  }

  submission = (id: string) => {
    if (!this.submissions.has(id)) {
      this.submissions.set(id, journalDomainSubmission(this.scope, id))
    }
    return this.submissions.get(id)
  }

  inputAttempt = (id: string) => {
    const row = this.scope.db
      .prepare(`SELECT facts_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
      .get(...this.scope.prefix, id)
    const facts = row
      ? this.scope.decode<JournalDomainSubmissionStoredFacts>(this.scope.examined(row).facts_json)
      : null
    return { fence: facts?.handover?.fence ?? facts?.admission.fence, ended: facts?.ended === true }
  }

  inputOrdinal = (id: string) => {
    let ordinal = this.ordinals.get(id)
    if (ordinal === undefined) {
      ordinal = journalDomainInputOrdinal(this.scope, id)
      this.ordinals.set(id, ordinal)
    }
    return ordinal
  }
  inputForItem = (id: string) => journalDomainInputForItem(this.scope, id)
  steerInput = (itemId: string) => journalDomainLatestSteer(this.scope, itemId)

  select = (selection: JournalStatusItemSelection): Iterable<JournalStatusItem> => {
    if (!['clear', 'boundary', 'prompt', 'assistant-exists'].includes(selection.kind)) {
      return sqlJournalStatusItems(this.scope, this.item, selection)
    }
    const key = JSON.stringify(selection)
    let items = this.selected.get(key)
    if (!items) {
      items = [...sqlJournalStatusItems(this.scope, this.item, selection)]
      this.selected.set(key, items)
    }
    return items
  }
  failedItems = (floor: number) => sqlFailedStatusItems(this.scope, this.item, floor)
  hasRequestItem = () => sqlHasStatusRequestItem(this.scope)
  relatedInputIds = (start: number, floor: number) =>
    sqlStatusRelatedInputIds(this.scope, start, floor)

  contextFloor = (): number => {
    const row = this.scope.db
      .prepare(`SELECT sequence FROM journal_items
      WHERE session_id=? AND epoch=? AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
      .get(...this.scope.prefix)
    return row ? Number(this.scope.examined(row).sequence) : 0
  }

  itemFence = (id: string) => this.current(id)?.fence

  runningTurn = () => {
    const boundary = this.select({ kind: 'boundary', raw: true })[Symbol.iterator]().next().value
    return boundary ? runningStructuredAgentSessionTurnItemBySequence([boundary.item]) : null
  }

  recoverableSubmissions = (): AgentJournalSubmission[] => {
    this.recoverable ??= [...journalDomainRecoverableSubmissions(this.scope)]
    return this.recoverable
  }

  statusInputs(afterStop?: number): AgentJournalSubmission[] {
    const existing = this.seeds.get(afterStop)
    if (existing) {
      return existing
    }
    let inputs: AgentJournalSubmission[]
    if (afterStop === undefined) {
      inputs = journalDomainStatusInputs(this.scope).map(({ input, ordinal }) => {
        this.ordinals.set(input.clientMessageId, ordinal)
        return input
      })
    } else {
      const base = this.statusInputs()
      const successor = journalDomainStatusInputAfter(this.scope, afterStop)
      if (
        !successor ||
        base.some((send) => send.clientMessageId === successor.input.clientMessageId)
      ) {
        inputs = base
      } else {
        this.ordinals.set(successor.input.clientMessageId, successor.ordinal)
        inputs = [...base, successor.input].sort(
          (a, b) =>
            a.submittedAt - b.submittedAt ||
            this.inputOrdinal(a.clientMessageId) - this.inputOrdinal(b.clientMessageId)
        )
      }
    }
    this.seeds.set(afterStop, inputs)
    return inputs
  }
}
