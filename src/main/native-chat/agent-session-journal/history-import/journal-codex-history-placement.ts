import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

export type CodexHistoryRoot = { segment: number; start: number; id: string }
type Placement = {
  group: CodexHistoryRoot
  kind: 'root' | 'opener' | 'item' | 'file'
  at: number
  position: number
  completedSnapshot: boolean
  turnGroup?: CodexHistoryRoot
}

const compareNumber = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)
const compareRoot = (a: CodexHistoryRoot, b: CodexHistoryRoot) =>
  compareNumber(a.segment, b.segment) ||
  compareNumber(a.start, b.start) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const slots = { root: 0, opener: 1, item: 2, file: 3 }

export function codexHistoryRootStart(payload: Record<string, unknown>, time: number) {
  return typeof payload.started_at === 'number' && Number.isFinite(payload.started_at)
    ? payload.started_at
    : payload.type === 'task_started' && Number.isFinite(time)
      ? time / 1000
      : undefined
}

export function createCodexHistoryPlacement() {
  const entries = new WeakMap<JournalReplacementItem, Placement>()
  let segment = 0,
    position = 0
  let frontier: CodexHistoryRoot = { segment, start: -Infinity, id: '' }
  return {
    beginSegment() {
      frontier = { segment: ++segment, start: -Infinity, id: '' }
      position = 0
    },
    root(id: string, startedAt: number): CodexHistoryRoot {
      const root = { segment, start: Math.floor(startedAt), id }
      if (compareRoot(root, frontier) > 0) {
        frontier = root
      }
      return root
    },
    get: (row: JournalReplacementItem | undefined) => (row ? entries.get(row) : undefined),
    turnGroup(row: JournalReplacementItem | undefined) {
      const group = row ? entries.get(row)?.turnGroup : undefined
      return group?.segment === segment ? group : undefined
    },
    set(
      row: JournalReplacementItem,
      previous: JournalReplacementItem | undefined,
      group: CodexHistoryRoot | undefined,
      at: number,
      kind: Placement['kind'],
      completedSnapshot: boolean
    ) {
      const old = previous ? entries.get(previous) : undefined
      const retained = kind === 'root' || (!group && old?.kind === 'file') ? old : undefined
      entries.set(row, {
        group: retained?.group ?? group ?? frontier,
        kind: retained?.kind ?? (group ? kind : 'file'),
        at: retained?.at ?? (group ? at : 0),
        position: retained?.position ?? (group ? old?.position : undefined) ?? position++,
        completedSnapshot,
        ...(kind === 'root' ? { turnGroup: group } : {})
      })
    },
    items(rows: JournalReplacementItem[]) {
      const keys = new Set(rows.map((row) => agentJournalItemKey(row.identity)))
      for (const row of rows) {
        if (row.body.kind === 'turn' && row.body.userItemId && !keys.has(row.body.userItemId)) {
          delete row.body.userItemId
        }
      }
      return rows.sort((a, b) => {
        const x = entries.get(a)!,
          y = entries.get(b)!
        return (
          compareRoot(x.group, y.group) ||
          slots[x.kind] - slots[y.kind] ||
          compareNumber(x.at, y.at) ||
          x.position - y.position
        )
      })
    }
  }
}
