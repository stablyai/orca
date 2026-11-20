import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { CrewInvalidation } from './crew-changes'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { FleetDurableWorker } from '../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import {
  createFleetStatusIndex,
  type FleetStatusIndex
} from '../../../../shared/orchestration/fleet/orchestration-fleet-status-index'

type Evidence = FleetAgentStatusEvidence
type IndexKey = 'byDispatchId' | 'byPaneKey' | 'byTerminalHandle'
const INDEX_KEYS: readonly IndexKey[] = ['byDispatchId', 'byPaneKey', 'byTerminalHandle']

/** A host's status rows by observed pane: replacing some panes' rows rekeys only the index entries they held. */
export class CrewStatusRows {
  /** The freshest row of each observed pane. */
  readonly byPane = new Map<string, Evidence>()
  readonly index: FleetStatusIndex
  private readonly rowsByPane = new Map<string, readonly Evidence[]>()
  /** Every row each index entry chose from, so a replaced row's entry falls back to the next freshest. */
  private readonly candidates: Record<IndexKey, Map<string, Set<Evidence>>> = {
    byDispatchId: new Map(),
    byPaneKey: new Map(),
    byTerminalHandle: new Map()
  }
  private readonly dispatchIds: ReadonlySet<string>
  private flat: readonly Evidence[] | undefined

  constructor(statuses: readonly Evidence[], workers: readonly FleetDurableWorker[]) {
    this.index = createFleetStatusIndex(statuses, workers)
    this.dispatchIds = new Set(workers.map((worker) => worker.dispatchId))
    this.flat = statuses
    const grouped = new Map<string, Evidence[]>()
    for (const row of statuses) {
      const rows = grouped.get(row.activity.paneKey) ?? []
      rows.push(row)
      grouped.set(row.activity.paneKey, rows)
      this.key(row)
    }
    for (const [pane, rows] of grouped) {
      this.setPane(pane, rows)
    }
  }

  get statuses(): readonly Evidence[] {
    return (this.flat ??= [...this.rowsByPane.values()].flat())
  }

  /** The rows these observed panes hold now. */
  rowsOf(panes: Iterable<string>): Evidence[] {
    return [...new Set(panes)].flatMap((pane) => this.rowsByPane.get(pane) ?? [])
  }

  /** Replaces every row of `panes` with `rows`, a fresh read of those panes. */
  replace(panes: ReadonlySet<string>, rows: readonly Evidence[]): void {
    const next = new Map<string, Evidence[]>()
    for (const row of rows) {
      const own = next.get(row.activity.paneKey) ?? []
      own.push(row)
      next.set(row.activity.paneKey, own)
    }
    const touched: Record<IndexKey, Set<string>> = {
      byDispatchId: new Set(),
      byPaneKey: new Set(),
      byTerminalHandle: new Set()
    }
    const affected = new Set([...panes, ...next.keys()])
    for (const row of this.rowsOf(affected)) {
      this.unkey(row, touched)
    }
    for (const pane of affected) {
      const own = next.get(pane) ?? []
      for (const row of own) {
        this.key(row, touched)
      }
      this.setPane(pane, own)
    }
    for (const kind of INDEX_KEYS) {
      for (const key of touched[kind]) {
        const freshest = pickFreshest(this.candidates[kind].get(key) ?? [])
        if (freshest) {
          this.index[kind].set(key, freshest)
        } else {
          this.index[kind].delete(key)
        }
      }
    }
    this.flat = undefined
  }

  private setPane(pane: string, rows: readonly Evidence[]): void {
    let freshest: Evidence | undefined
    for (const row of rows) {
      if (!freshest || row.deliveredAt > freshest.deliveredAt) {
        freshest = row
      }
    }
    if (freshest) {
      this.rowsByPane.set(pane, rows)
      this.byPane.set(pane, freshest)
    } else {
      this.rowsByPane.delete(pane)
      this.byPane.delete(pane)
    }
  }

  /** The index entries a row competes for: the same keys createFleetStatusIndex admits. */
  private keysOf(row: Evidence): [IndexKey, string][] {
    const binding = row.binding
    if (binding.kind === 'unresolved') {
      return []
    }
    const keys: [IndexKey, string][] = []
    if (binding.kind === 'worker' && this.dispatchIds.has(binding.dispatchId)) {
      keys.push(['byDispatchId', binding.dispatchId])
    }
    if (this.index.paneOwners.has(binding.paneKey)) {
      keys.push(['byPaneKey', binding.paneKey])
    }
    if (this.index.handleOwners.has(binding.terminalHandle)) {
      keys.push(['byTerminalHandle', binding.terminalHandle])
    }
    return keys
  }

  private key(row: Evidence, touched?: Record<IndexKey, Set<string>>): void {
    for (const [kind, key] of this.keysOf(row)) {
      const rows = this.candidates[kind].get(key) ?? new Set()
      rows.add(row)
      this.candidates[kind].set(key, rows)
      touched?.[kind].add(key)
    }
  }

  private unkey(row: Evidence, touched: Record<IndexKey, Set<string>>): void {
    for (const [kind, key] of this.keysOf(row)) {
      const rows = this.candidates[kind].get(key)
      rows?.delete(row)
      if (rows?.size === 0) {
        this.candidates[kind].delete(key)
      }
      touched[kind].add(key)
    }
  }
}

/** As createFleetStatusIndex: the latest delivery wins, the earlier row on a tie. */
function pickFreshest(rows: Iterable<Evidence>): Evidence | undefined {
  let freshest: Evidence | undefined
  for (const row of rows) {
    if (!freshest || freshest.deliveredAt < row.deliveredAt) {
      freshest = row
    }
  }
  return freshest
}

/** The panes whose status rows changed since the last take; every row past `cap`, or for a wake that named none. */
export class CrewStatusWakes {
  private readonly panes = new Set<string>()
  private broad = false

  constructor(private readonly cap: number) {}

  note(facets: CrewInvalidation): void {
    if (!facets.paneKeys && !facets.sessionIds) {
      this.broad = true
      return
    }
    // A chat's status row lives at its derived pane key.
    const chats = [...(facets.sessionIds ?? [])].map((session) =>
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(session), session)
    )
    for (const pane of [...(facets.paneKeys ?? []), ...chats]) {
      if (this.panes.size >= this.cap) {
        this.broad = true
        return
      }
      this.panes.add(pane)
    }
  }

  /** The noted panes, or undefined for every row; resets the note. */
  take(): ReadonlySet<string> | undefined {
    const panes = this.broad ? undefined : new Set(this.panes)
    this.panes.clear()
    this.broad = false
    return panes
  }
}
