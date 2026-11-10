import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import type { PtyPaneOf } from '../../terminal/surface/pty-pane-query'

/** One capture returns an unchanged, complete array per stable leaf or exact legacy pane. */
export type OrchestrationTerminalCandidates = (pane: string) => readonly {
  paneKey: string
  handles: Iterable<string>
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
  const requests = new Map<string, ReturnType<OrchestrationTerminalCandidates>>()
  return (pane) => {
    const parsed = parsePaneKey(pane)
    const key = parsed ? `leaf:${parsed.leafId}` : `pane:${pane}`
    const cached = requests.get(key)
    if (cached) {
      return cached
    }
    const panes = new Map<string, RuntimePtyWorktreeRecord[]>()
    if (parsed) {
      for (const id of source.leavesForId(parsed.leafId)) {
        const leaf = source.leaves.get(id)
        if (leaf?.ptyId) {
          panes.set(source.makePaneKey(leaf), [])
        }
      }
    }
    for (const id of ptysFor(pane)) {
      const pty = source.ptys.get(id)
      const address = pty && paneOf(pty)
      if (pty && address) {
        const records = panes.get(address) ?? []
        records.push(pty)
        panes.set(address, records)
      }
    }
    const groups = [...panes].map(([paneKey, ptys]) => ({
      paneKey,
      handles: {
        *[Symbol.iterator]() {
          const seen = new Set<string>()
          const parsed = parsePaneKey(paneKey)
          const leaf = parsed
            ? source.leaves.get(source.leafKey(parsed.tabId, parsed.leafId))
            : undefined
          if (leaf?.ptyId) {
            const handle = source.issueLeaf(leaf)
            seen.add(handle)
            yield handle
          }
          // Mint fallback identities only if the preceding candidate had no context.
          for (const pty of ptys) {
            const handle = source.issuePty(pty)
            if (!seen.has(handle)) {
              seen.add(handle)
              yield handle
            }
          }
        }
      }
    }))
    requests.set(key, groups)
    return groups
  }
}
