import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { OrderedTerminalCandidates } from './ordered-terminal-candidates'

/** Raw address membership; connectivity and pane authority remain read-time decisions. */
export class TerminalPaneCandidates {
  readonly leaves = new OrderedTerminalCandidates()
  private readonly ptys = new OrderedTerminalCandidates()

  leavesForId(id: string): readonly string[] {
    return this.leaves.matching([id])
  }

  ptysForPane(pane: string): readonly string[] {
    const leaf = parsePaneKey(pane)?.leafId
    return this.ptys.matching([`pane:${pane}`, ...(leaf ? [`leaf:${leaf}`] : [])])
  }

  setPty(record: RuntimePtyWorktreeRecord): void {
    const pane = record.paneKey
    const leaf = pane ? parsePaneKey(pane)?.leafId : null
    this.ptys.set(record.ptyId, pane ? [`pane:${pane}`, ...(leaf ? [`leaf:${leaf}`] : [])] : [])
  }

  removePty(id: string): void {
    this.ptys.delete(id)
  }
}
