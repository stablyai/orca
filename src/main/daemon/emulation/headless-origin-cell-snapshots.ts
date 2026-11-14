import type {
  OriginBufferLine,
  OriginCell,
  OriginLineAttachment
} from './headless-content-origin-lines'
import { readOriginLineAttachment } from './headless-content-origin-lines'
import {
  terminalOriginAt,
  terminalOriginSpan,
  type TerminalOriginRuns
} from '../../../shared/terminal/output/terminal-content-origin'

type OriginCellSnapshot = {
  runs: TerminalOriginRuns
  index: number
  component?: TerminalOriginRuns
}

/** A reused editor cell keeps the provenance captured when it was loaded. */
export class HeadlessOriginCellSnapshots {
  private readonly cells = new WeakMap<OriginCell, OriginCellSnapshot>()
  constructor(
    private readonly read: (line: OriginBufferLine) => OriginLineAttachment,
    private readonly write: (
      line: OriginBufferLine,
      index: number,
      runs: TerminalOriginRuns,
      component?: TerminalOriginRuns
    ) => void,
    private readonly erase: (state: OriginLineAttachment, index: number) => void
  ) {}

  set(line: OriginBufferLine, index: number, cell: OriginCell): void {
    const state = this.read(line)
    const origin = this.get(cell)
    state.originals.setCell.call(line, index, cell)
    if (state.editing) {
      if (state.recordSets) {
        this.erase(state, index)
      }
    } else {
      this.write(
        line,
        index,
        origin ? terminalOriginSpan(1, terminalOriginAt(origin.runs, origin.index)) : [],
        origin?.component
      )
    }
  }

  get(cell: OriginCell): OriginCellSnapshot | undefined {
    return this.cells.get(cell)
  }

  load(line: OriginBufferLine, index: number, cell: OriginCell): OriginCell {
    const attached = readOriginLineAttachment(line)!
    const state = this.read(line)
    const result = attached.originals.loadCell.call(line, index, cell)
    if (attached.editing) {
      return result
    }
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
