import type { OriginBufferLine } from './headless-content-origin-lines'
import type { HeadlessOriginLineEdits } from './headless-origin-line-edits'

type Print = OriginBufferLine['setCellFromCodepoint']
type Combine = OriginBufferLine['addCodepointToCell']

/** Keep xterm's per-character call targets shared while each line retains its own editor. */
export class HeadlessOriginPrintHooks {
  private readonly lines = new WeakMap<
    OriginBufferLine,
    { edits: HeadlessOriginLineEdits; print: Print; combine: Combine }
  >()
  private readonly print: Print
  private readonly combine: Combine

  constructor(
    printed: (line: OriginBufferLine, index: number, width: number, code: number) => void,
    combined: (
      line: OriginBufferLine,
      index: number,
      code: number,
      width: number,
      original: Combine
    ) => void
  ) {
    const lines = this.lines
    this.print = function (this: OriginBufferLine, index, code, width, attrs) {
      const state = lines.get(this)!
      state.print.call(this, index, code, width, attrs)
      if (!state.edits.collect(index, true)) {
        printed(this, index, width, code)
      }
    }
    this.combine = function (this: OriginBufferLine, index, code, width) {
      combined(this, index, code, width, lines.get(this)!.combine)
    }
  }

  attach(line: OriginBufferLine, edits: HeadlessOriginLineEdits): void {
    this.lines.set(line, {
      edits,
      print: line.setCellFromCodepoint,
      combine: line.addCodepointToCell
    })
    line.setCellFromCodepoint = this.print
    line.addCodepointToCell = this.combine
  }
}
