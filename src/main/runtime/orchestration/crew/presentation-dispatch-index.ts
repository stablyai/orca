import { DispatchPresentationDeadlines } from './dispatch-presentation-deadlines'
import { DispatchPresentationPriority } from './dispatch-presentation-priority'
import { dispatchCompletionEpoch } from '../db/dispatch-context/dispatch-completion-epoch'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { DispatchContextRow } from '../db/orchestration-records'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../db/row-column-lists'
import {
  readPresentationDispatchCandidates,
  isRecentPresentationDispatch
} from '../db/dispatch-context/dispatch-presentation'
import { paneKeyMatchSuffix } from '../db/pane-key-match'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

type Candidate = DispatchContextRow & { presentation_order: number }
const active = (row: DispatchContextRow) => row.status === 'pending' || row.status === 'dispatched'
const paneAddress = (key: string) => `pane:${parsePaneKey(key) ? paneKeyMatchSuffix(key) : key}`
type Read = <T>(owner: string, key: string, dependencies: readonly string[], read: () => T) => T

export class PresentationDispatchIndex {
  private readonly candidates = new Map<string, Candidate>()
  private readonly addresses = new Map<string, Set<string>>()
  private readonly allWinners = new Map<string, DispatchPresentationPriority>()
  private readonly activeWinners = new Map<string, DispatchPresentationPriority>()
  private readonly expiry = new DispatchPresentationDeadlines()
  constructor(
    private readonly db: OrchestrationDb,
    private readonly read: Read,
    private readonly release: (id: string) => void
  ) {}
  refresh(now: number, dirty: readonly string[], cold: boolean): void {
    if (cold) {
      for (const row of readPresentationDispatchCandidates(this.db, now)) {
        if (active(row) || isRecentPresentationDispatch(row, now)) {
          this.put(row)
        }
      }
    } else {
      for (const key of dirty) {
        if (!key.startsWith('candidate:')) {
          continue
        }
        const id = key.slice(10)
        this.remove(id)
        const raw = this.db.db
          .prepare(
            `SELECT rowid AS presentation_order, ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE id = ?`
          )
          .get(id)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: complete schema-owned dispatch projection plus SQLite rowid.
        const row = raw as Candidate | undefined
        if (row && (active(row) || isRecentPresentationDispatch(row, now))) {
          this.put(row)
        }
      }
    }
    for (const id of this.expiry.expired(now)) {
      this.remove(id)
    }
  }
  get size(): number {
    return this.candidates.size
  }
  rows(): IterableIterator<Candidate> {
    return this.candidates.values()
  }
  has(id: string): boolean {
    return this.candidates.has(id)
  }
  clear(): void {
    this.expiry.clear()
    this.candidates.clear()
    this.addresses.clear()
    this.allWinners.clear()
    this.activeWinners.clear()
  }
  private keys(row: DispatchContextRow): string[] {
    return [
      ...(row.assignee_handle ? [`handle:${row.assignee_handle}`] : []),
      ...(row.assignee_pane_key
        ? [paneAddress(row.assignee_pane_key), `exact:${row.assignee_pane_key}`]
        : []),
      ...(row.assignee_orca_session_id ? [`session:${row.assignee_orca_session_id}`] : [])
    ]
  }

  private put(row: Candidate): void {
    this.candidates.set(row.id, row)
    if (!active(row) && row.completed_at) {
      const completed = dispatchCompletionEpoch(row.completed_at)
      if (completed !== null) {
        this.expiry.set(row.id, completed + AGENT_STATUS_STALE_AFTER_MS)
      }
    }
    for (const key of this.keys(row)) {
      const bucket = this.addresses.get(key) ?? new Set()
      bucket.add(row.id)
      this.addresses.set(key, bucket)
      this.order(this.allWinners, key, row)
      if (active(row)) {
        this.order(this.activeWinners, key, row)
      }
    }
  }

  private remove(id: string): void {
    const row = this.candidates.get(id)
    if (row) {
      for (const key of this.keys(row)) {
        const bucket = this.addresses.get(key)
        this.unorder(this.allWinners, key, id)
        this.unorder(this.activeWinners, key, id)
        bucket?.delete(id)
        if (bucket?.size === 0) {
          this.addresses.delete(key)
        }
      }
    }
    this.expiry.delete(id)
    this.candidates.delete(id)
    this.release(id)
  }

  private order(
    buckets: Map<string, DispatchPresentationPriority>,
    key: string,
    row: Candidate
  ): void {
    const bucket = buckets.get(key) ?? new DispatchPresentationPriority()
    bucket.set(row.id, -row.presentation_order)
    buckets.set(key, bucket)
  }

  private unorder(
    buckets: Map<string, DispatchPresentationPriority>,
    key: string,
    id: string
  ): void {
    const bucket = buckets.get(key)
    bucket?.delete(id)
    if (bucket?.size === 0) {
      buckets.delete(key)
    }
  }

  private newest(key: string, onlyActive = true): Candidate | undefined {
    const id = (onlyActive ? this.activeWinners : this.allWinners).get(key)?.peek()?.id
    return id === undefined ? undefined : this.candidates.get(id)
  }

  activeFor(handle: string, pane?: string): Candidate | undefined {
    return (
      this.newest(`handle:${handle}`) ??
      (pane
        ? (this.newest(`exact:${pane}`) ??
          (parsePaneKey(pane) ? this.newest(paneAddress(pane)) : undefined))
        : undefined)
    )
  }

  latest(handle: string): DispatchContextRow | undefined {
    const candidate = this.newest(`handle:${handle}`, false)
    return candidate
      ? this.read(candidate.id, `latest:${handle}`, [`handle:${handle}`], () =>
          this.db.getLatestDispatchForTerminal(handle)
        )
      : undefined
  }

  sessions(now: number, sessions?: readonly string[]) {
    const candidates = sessions
      ? sessions.flatMap((id) =>
          [...(this.addresses.get(`session:${id}`) ?? [])].flatMap(
            (key) => this.candidates.get(key) ?? []
          )
        )
      : [...this.candidates.values()].filter((row) => row.assignee_orca_session_id)
    const selected = new Map<string, Candidate>()
    for (const row of candidates) {
      const address = row.assignee_handle
        ? `handle:${row.assignee_handle}`
        : `session:${row.assignee_orca_session_id}`
      const previous = selected.get(address)
      if (
        !previous ||
        (active(row) && !active(previous)) ||
        (active(row) === active(previous) && row.presentation_order > previous.presentation_order)
      ) {
        selected.set(address, row)
      }
    }
    return [...selected].flatMap(([key, row]) => {
      const latest =
        active(row) && !row.assignee_handle
          ? this.newest(`session:${row.assignee_orca_session_id}`)
          : this.read(row.id, `session-latest:${active(row)}:${key}`, [key], () =>
              this.db.db
                .prepare(
                  `SELECT rowid AS n FROM dispatch_contexts WHERE ${row.assignee_handle ? 'assignee_handle' : 'assignee_orca_session_id'} = ? ${active(row) ? "AND status IN ('pending', 'dispatched')" : ''} ORDER BY rowid DESC LIMIT 1`
                )
                .get(row.assignee_handle || row.assignee_orca_session_id)
            )
      const order =
        latest && ('presentation_order' in latest ? latest.presentation_order : latest.n)
      return order === row.presentation_order &&
        (active(row) || isRecentPresentationDispatch(row, now))
        ? [{ dispatch: row, order: row.presentation_order }]
        : []
    })
  }
}
