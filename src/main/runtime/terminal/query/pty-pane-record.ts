import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { PtyPaneOf } from '../surface/pty-pane-query'
import type { TerminalIdentityReadContext } from './terminal-identity-read-context'

export function ptyRecordForPaneKey(
  paneKey: string,
  source: {
    leaves: ReadonlyMap<string, RuntimeLeafRecord>
    ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
    leafKey: (tab: string, leaf: string) => string
    capturePaneOf: () => PtyPaneOf
    paneOf?: PtyPaneOf
    leavesForId?: (id: string) => Iterable<string>
    ptysForPane?: (pane: string) => Iterable<string>
  },
  context?: TerminalIdentityReadContext
): RuntimePtyWorktreeRecord | null {
  const parsed = parsePaneKey(paneKey)
  let leafPty: RuntimePtyWorktreeRecord | null = null
  if (parsed) {
    const leaf = source.leaves.get(source.leafKey(parsed.tabId, parsed.leafId))
    const pty = leaf?.ptyId ? source.ptys.get(leaf.ptyId) : undefined
    if (pty?.connected) {
      return pty
    }
    leafPty = pty ?? null
    const candidates = context
      ? context.leavesForId(parsed.leafId)
      : (source.leavesForId?.(parsed.leafId) ?? source.leaves.keys())
    for (const key of candidates) {
      const candidate = source.leaves.get(key)
      if (!candidate) {
        continue
      }
      if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
        continue
      }
      const remintedPty = source.ptys.get(candidate.ptyId)
      if (remintedPty?.connected) {
        return remintedPty
      }
      leafPty ??= remintedPty ?? null
    }
  }
  let newestMatch: RuntimePtyWorktreeRecord | null = null
  let paneOf: PtyPaneOf | undefined
  const candidates = context
    ? context.ptysForPane(paneKey)
    : (source.ptysForPane?.(paneKey) ?? source.ptys.keys())
  for (const ptyId of candidates) {
    const pty = source.ptys.get(ptyId)
    if (!pty) {
      continue
    }
    const recordedPaneKey = (paneOf ??= context?.paneOf ?? source.paneOf ?? source.capturePaneOf())(
      pty
    ).paneKey
    const ptyPane = parsePaneKey(recordedPaneKey ?? '')
    if (recordedPaneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
      if (pty.connected) {
        return pty
      }
      newestMatch = pty
    }
  }
  return leafPty ?? newestMatch
}
