import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'
import { JournalSqlReadValues } from './journal-sql-read-values'
import { JournalSqlScalars } from './journal-sql-scalars'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalStatusItem, JournalStatusItemSelection } from './journal-status-items'
import { sqlJournalStatusItems } from './journal-sql-status-items'
import { sqlFailedStatusItems, sqlHasStatusRequestItem } from './journal-sql-status-request-items'
import { sqlStatusRelatedInputIds } from './journal-sql-status-inputs'

/** Readonly facts and decoded incarnations live only for this caller's SQL snapshot. */
export class JournalSqlStatusContext {
  private readonly values: JournalSqlReadValues
  private readonly selected = new Map<string, JournalStatusItem[]>()
  private readonly ordinals = new Map<string, number>()
  private readonly seeds = new Map<number | undefined, AgentJournalSubmission[]>()
  readonly epoch: string
  readonly sequence: number
  private recoverable: AgentJournalSubmission[] | undefined
  readonly submissionCount: number
  readonly stop: JournalLatestStop | null

  constructor(readonly scope: JournalSqlScope) {
    this.values = new JournalSqlReadValues(scope, () => {})
    const reducer = new JournalSqlScalars(scope, 'reducer')
    this.epoch = journalContextEpoch(scope.epoch, reducer.get('contextBoundary', 1))
    this.sequence = reducer.get('lastSequence', 0)
    this.submissionCount = new JournalSqlScalars(scope, 'evidence').get('nextOrdinal', 0)
    this.stop = new JournalSqlScalars(scope, 'pause-marks').get<{
      latestStop: JournalLatestStop | null
    }>('header', { latestStop: null }).latestStop
  }

  item = (id: string) => this.values.get<AgentJournalRenderItem>('items', id)

  displayed = (id: string): AgentJournalRenderItem | null => {
    const item = this.item(id)
    const identity = parseAgentJournalItemKey(id)
    return item?.itemId === id &&
      (identity?.provider !== 'orca' ||
        !this.values.has('inputs.rejections', identity.clientMessageId) ||
        this.values.has('inputs.presentations', identity.clientMessageId))
      ? projectJournalStopNote(item, {
          get: this.item,
          has: (key) => this.values.has('items', key)
        })
      : null
  }

  submission = (id: string) => this.values.get<AgentJournalSubmission>('submissions', id)
  inputOrdinal = (id: string) => {
    let ordinal = this.ordinals.get(id)
    if (ordinal === undefined) {
      ordinal = this.values.get<number>('evidence.ordinals', id) ?? Infinity
      this.ordinals.set(id, ordinal)
    }
    return ordinal
  }
  inputForItem = (id: string) => {
    const input = this.values.get<string>('observations.inputIds', id)
    return input === undefined ? undefined : this.submission(input)
  }
  select = (selection: JournalStatusItemSelection): Iterable<JournalStatusItem> => {
    if (
      selection.kind !== 'clear' &&
      selection.kind !== 'boundary' &&
      selection.kind !== 'prompt' &&
      selection.kind !== 'assistant-exists'
    ) {
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

  steerInput = (itemId: string) => {
    const id = new JournalSqlPlaceIndex(this.scope, `steers:${JSON.stringify(itemId)}`).lastId()
    return id === undefined ? undefined : this.submission(id)
  }

  itemFence = (id: string) =>
    this.values.get<number>('itemExecutionOwners', id) ?? this.values.get<number>('itemFences', id)

  runningTurn = () => {
    const boundary = this.select({ kind: 'boundary', raw: true })[Symbol.iterator]().next().value
    return boundary ? runningStructuredAgentSessionTurnItemBySequence([boundary.item]) : null
  }

  recoverableSubmissions = (): AgentJournalSubmission[] => {
    if (!this.recoverable) {
      const candidates = [...this.memberIds('journal_proj_recoverable_inputs')].flatMap((id) => {
        const input = this.values.get<AgentJournalSubmission>('evidence.recoverable', id)
        return input ? [{ input, ordinal: this.inputOrdinal(id) }] : []
      })
      candidates.sort((a, b) => a.ordinal - b.ordinal)
      this.recoverable = candidates.map(({ input }) => input)
    }
    return this.recoverable
  };

  private *memberIds(
    table: 'journal_proj_pending_status_inputs' | 'journal_proj_recoverable_inputs'
  ) {
    let after = -1
    for (;;) {
      const rows = this.scope.db
        .prepare(`SELECT input_id,ordinal FROM ${table}
        WHERE session_id=? AND epoch=? AND current=1 AND ordinal>? ORDER BY ordinal LIMIT 128`)
        .all(...this.scope.prefix, after)
      for (const row of rows) {
        this.scope.examined(row)
        yield String(row.input_id)
      }
      const last = rows.at(-1)
      if (rows.length < 128 || !last) {
        return
      }
      after = Number(last.ordinal)
    }
  }

  statusInputs(afterStop?: number): AgentJournalSubmission[] {
    const existing = this.seeds.get(afterStop)
    if (existing) {
      return existing
    }
    if (afterStop !== undefined) {
      const base = this.statusInputs()
      const id = new JournalSqlPlaceIndex(this.scope, 'non-refused-inputs').successorId(afterStop)
      const successor = id === undefined ? undefined : this.submission(id)
      if (!successor || base.some((send) => send.clientMessageId === successor.clientMessageId)) {
        this.seeds.set(afterStop, base)
        return base
      }
      const candidates = [...base, successor].map((input) => ({
        input,
        ordinal: this.inputOrdinal(input.clientMessageId)
      }))
      candidates.sort((a, b) => a.input.submittedAt - b.input.submittedAt || a.ordinal - b.ordinal)
      const inputs = candidates.map(({ input }) => input)
      this.seeds.set(afterStop, inputs)
      return inputs
    }
    const ids = new Set(this.memberIds('journal_proj_pending_status_inputs'))
    const add = (id: string | undefined) => {
      if (id !== undefined) {
        ids.add(id)
      }
    }
    add(new JournalSqlPlaceIndex(this.scope, 'accepted-by-time').lastId())
    add(new JournalSqlPlaceIndex(this.scope, 'failed-requests').lastId())
    const candidates = [...ids].flatMap((id) => {
      const input = this.submission(id)
      return input ? [{ input, ordinal: this.inputOrdinal(id) }] : []
    })
    candidates.sort((a, b) => a.input.submittedAt - b.input.submittedAt || a.ordinal - b.ordinal)
    const inputs = candidates.map(({ input }) => input)
    this.seeds.set(afterStop, inputs)
    return inputs
  }
}
