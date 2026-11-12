import { readJournalSqlStatusHead } from './journal-sql-status-head'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  readJournalSqlWorkItems,
  hydrateJournalSqlWorkDependencies
} from './journal-sql-work-items'
import {
  journalDomainFirstQueuedInput,
  journalDomainUnsettledInputs
} from './journal-domain-input-populations'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { JournalSqlScope } from './journal-sql-scope'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import type { JournalStatusItem, JournalStatusItemSelection } from './journal-status-items'
import { sqlJournalStatusItems, sqlJournalStatusItem } from './journal-sql-status-items'
import { sqlFailedStatusItems, sqlHasStatusRequestItem } from './journal-sql-status-request-items'
import { sqlStatusRelatedInputIds } from './journal-sql-status-inputs'
import { readJournalDomainStopStates } from './journal-domain-item-display'
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
    | {
        item: AgentJournalRenderItem
        displayed: AgentJournalRenderItem
        hidden: boolean
        fence: number
      }
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

  private unsettled: AgentJournalSubmission[] | undefined
  private workFloor: number | undefined

  readonly inputHead: SqliteRow | undefined
  private rawWorkFloor: number | undefined

  constructor(
    readonly scope: JournalSqlScope,
    work?: 'state' | 'input'
  ) {
    const row = readJournalSqlStatusHead(scope, work)
    if (!row) {
      throw new Error('journal status read targets a retired chat epoch')
    }
    scope.examined(row)
    this.inputHead = work === 'input' ? row : undefined
    if (work) {
      this.workFloor = Number(row.work_floor ?? 0)
      this.rawWorkFloor = Number(row.raw_work_floor ?? 0)
    }
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
        this.remember(row, id)
      } else {
        this.items.set(id, undefined)
      }
    }
    return this.items.get(id)
  }

  private remember(
    row: SqliteRow,
    id: string,
    states?: ReturnType<typeof readJournalDomainStopStates>
  ) {
    if (this.items.has(id)) {
      return
    }
    this.items.set(id, sqlJournalStatusItem(this.scope, row, id, states))
  }

  private rememberAll(rows: SqliteRow[]) {
    const stale = rows.filter(
      (row) => row.payload_json != null && row.wire_version !== AGENT_SESSION_ITEM_WIRE_VERSION
    )
    const states = stale.length
      ? readJournalDomainStopStates(
          this.scope.db,
          this.scope,
          stale.map((row) => String(row.item_id))
        )
      : undefined
    for (const row of rows) {
      const id = String(row.item_id)
      if (row.payload_json === null) {
        this.items.set(id, undefined)
      } else {
        this.remember(row, id, states)
      }
    }
  }

  /** Work-only populations and their reciprocal turn/opener facts share this snapshot. */
  prepareWork() {
    const selections = new Map<string, JournalStatusItem[]>([
      ['raw', []],
      ['boundary', []],
      ['pending-prompts', []]
    ])
    const rows = readJournalSqlWorkItems(this.scope)
    this.rememberAll(rows)
    for (const row of rows) {
      const id = String(row.item_id)
      selections.get(String(row.selection))?.push({
        item: this.items.get(id)!.item,
        position: {
          sequence: Number(row.sequence),
          sequenceIndex: Number(row.sequence_index),
          ordinal: Number(row.ordinal)
        }
      })
    }
    for (const [key, items] of selections) {
      this.selected.set(
        JSON.stringify(key === 'raw' ? { kind: 'boundary', raw: true } : { kind: key }),
        items
      )
    }
    const sources = rows.flatMap((row) => {
      const current = this.items.get(String(row.item_id))
      return current && !current.hidden ? [current.displayed] : []
    })
    hydrateJournalSqlWorkDependencies(
      this.scope,
      sources,
      (id) => {
        const current = this.items.get(id)
        return current && !current.hidden
          ? current.displayed
          : this.items.has(id)
            ? null
            : undefined
      },
      (rows) => this.rememberAll(rows)
    )
    this.unsettled = [...journalDomainUnsettledInputs(this.scope)]
    this.recoverable = this.unsettled.filter(
      (send) => send.dispatchState === 'pending' || !send.recovered
    )
    for (const send of this.unsettled) {
      this.submissions.set(send.clientMessageId, send)
    }
  }

  commandFloor = () =>
    this.workFloor ??
    this.select({ kind: 'clear' })[Symbol.iterator]().next().value?.item.sequence ??
    0

  enteredSubmissions = () =>
    (this.unsettled ?? [...journalDomainUnsettledInputs(this.scope)]).filter(
      (send) => !isQueuedAgentJournalSubmission(send)
    )
  sendingSubmissions = () =>
    (this.unsettled ?? [...journalDomainUnsettledInputs(this.scope)]).filter(
      (send) => send.dispatchState === 'pending'
    )
  firstQueuedInput = () =>
    this.unsettled
      ? this.sendingSubmissions().find(isQueuedAgentJournalSubmission)
      : journalDomainFirstQueuedInput(this.scope)

  item = (id: string) => this.current(id)?.item

  /** Semantic display uses the writer's saved Stop rewrite without shortening ordinary items. */
  displayed = (id: string): AgentJournalRenderItem | null => {
    const row = this.current(id)
    return row && !row.hidden ? row.displayed : null
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
    const prepared = this.selected.get(JSON.stringify(selection))
    if (prepared) {
      return prepared
    }
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
    if (this.rawWorkFloor !== undefined) {
      return this.rawWorkFloor
    }
    const row = this.scope.db
      .prepare(`SELECT sequence FROM journal_items
      WHERE session_id=? AND epoch=? AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
      .get(...this.scope.prefix)
    return row ? Number(this.scope.examined(row).sequence) : 0
  }

  itemFence = (id: string) => this.current(id)?.fence

  runningTurn = () => {
    const item = this.select({ kind: 'boundary', raw: true })[Symbol.iterator]().next().value?.item
    const turn = item ? readAgentJournalTurn(item.body) : null
    return item && turn?.state === 'running' ? { item, turnId: turn.turnId } : null
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
