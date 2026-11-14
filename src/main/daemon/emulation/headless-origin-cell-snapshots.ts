import type {
  OriginBufferLine,
  OriginCell,
  OriginLineAttachment
} from './headless-content-origin-lines'
import { readOriginLineAttachment } from './headless-content-origin-lines'
import type { TerminalOriginRuns } from '../../../shared/terminal/output/terminal-content-origin'

type OriginCellSnapshot = {
  runs: TerminalOriginRuns
  index: number
  component?: TerminalOriginRuns
}

/** A reused editor cell keeps the provenance captured when it was loaded. */
export class HeadlessOriginCellSnapshots {
  private readonly cells = new WeakMap<OriginCell, OriginCellSnapshot>()
  constructor(private readonly read: (line: OriginBufferLine) => OriginLineAttachment) {}

  get(cell: OriginCell): OriginCellSnapshot | undefined {
    return this.cells.get(cell)
  }

  load(line: OriginBufferLine, index: number, cell: OriginCell): OriginCell {
    const attached = readOriginLineAttachment(line)!
    const result = attached.originals.loadCell.call(line, index, cell)
    if (attached.editing) {
      return result
    }
    const state = this.read(line)
    const snapshot = this.cells.get(result)
    if (snapshot) {
      snapshot.runs = state.runs
      snapshot.index = index
      snapshot.component = state.components?.get(index)
    } else {
      this.cells.set(result, { runs: state.runs, index, component: state.components?.get(index) })
    }
    return result
  }
}
