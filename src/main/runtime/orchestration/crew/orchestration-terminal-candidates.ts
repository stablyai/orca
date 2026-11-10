import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import type { PtyPaneOf } from '../../terminal/surface/pty-pane-query'

export type OrchestrationTerminalCandidates = (pane: string) => readonly {
  paneKey: string
  handles: readonly string[]
}[]

/** One read scope, retaining source order without choosing a terminal from dispatch insertion order. */
export function captureOrchestrationTerminalCandidates(source: {
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  leafKey(tab: string, leaf: string): string
  leavesForId(id: string): Iterable<string>
  ptysForPane?: (pane: string) => Iterable<string>
  capturePaneOf(): PtyPaneOf
  paneOf?: PtyPaneOf
  makePaneKey(leaf: RuntimeLeafRecord): string
  issueLeaf(leaf: RuntimeLeafRecord): string
  issuePty(pty: RuntimePtyWorktreeRecord): string
}): OrchestrationTerminalCandidates {
  let captured:
    | { panes: Map<string, string[]>; leaves: Map<string, string[]>; read: PtyPaneOf }
    | undefined
  const ptysFor = (pane: string): Iterable<string> => {
    if (source.ptysForPane) {
      return source.ptysForPane(pane)
    }
    if (!captured) {
      captured = { panes: new Map(), leaves: new Map(), read: source.capturePaneOf() }
      for (const pty of source.ptys.values()) {
        const key = captured.read(pty).paneKey
        if (!key) {
          continue
        }
        const leaf = parsePaneKey(key)?.leafId
        for (const [map, address] of [
          [captured.panes, key],
          [captured.leaves, leaf]
        ] as const) {
          if (!address) {
            continue
          }
          const ids = map.get(address) ?? []
          ids.push(pty.ptyId)
          map.set(address, ids)
        }
      }
    }
    const leaf = parsePaneKey(pane)?.leafId
    return leaf ? (captured.leaves.get(leaf) ?? []) : (captured.panes.get(pane) ?? [])
  }
  const paneOf = (pty: RuntimePtyWorktreeRecord) =>
    (source.paneOf ?? captured?.read ?? source.capturePaneOf())(pty).paneKey
  const groups = new Map<string, { paneKey: string; handles: readonly string[] }>()
  const group = (paneKey: string) => {
    let result = groups.get(paneKey)
    if (!result) {
      const handles = new Set<string>()
      const parsed = parsePaneKey(paneKey)
      const leaf = parsed
        ? source.leaves.get(source.leafKey(parsed.tabId, parsed.leafId))
        : undefined
      if (leaf?.ptyId) {
        handles.add(source.issueLeaf(leaf))
      }
      for (const id of ptysFor(paneKey)) {
        const pty = source.ptys.get(id)
        if (pty && paneOf(pty) === paneKey) {
          handles.add(source.issuePty(pty))
        }
      }
      result = { paneKey, handles: [...handles] }
      groups.set(paneKey, result)
    }
    return result
  }
  return (pane) => {
    const panes = new Set<string>()
    const parsed = parsePaneKey(pane)
    if (parsed) {
      for (const id of source.leavesForId(parsed.leafId)) {
        const leaf = source.leaves.get(id)
        if (leaf?.ptyId) {
          panes.add(source.makePaneKey(leaf))
        }
      }
    }
    for (const id of ptysFor(pane)) {
      const pty = source.ptys.get(id)
      const key = pty && paneOf(pty)
      if (key) {
        panes.add(key)
      }
    }
    return [...panes].map(group)
  }
}
