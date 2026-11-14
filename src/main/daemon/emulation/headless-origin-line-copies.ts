import {
  readOriginLineAttachment,
  type OriginBufferLine,
  type OriginLineAttachment,
  type OriginLineState
} from './headless-content-origin-lines'
import { replaceOriginCells } from './headless-origin-line-edits'

/** Native copies and custom wrappers use the same before-image. */
export class HeadlessOriginLineCopies {
  constructor(
    private readonly read: (line: OriginBufferLine) => OriginLineAttachment,
    private readonly attach: (line: OriginBufferLine) => OriginBufferLine,
    private readonly assign: (line: OriginBufferLine, state: OriginLineState) => void
  ) {}

  beforeCopy(source: OriginBufferLine, blank?: boolean): OriginLineState {
    const state = this.read(source)
    return {
      runs: state.runs,
      components: !blank && state.components?.size ? new Map(state.components) : undefined
    }
  }

  copied(line: OriginBufferLine, state: OriginLineState): void {
    this.assign(this.attach(line), state)
  }

  beforeCells(
    line: OriginBufferLine,
    source: OriginBufferLine,
    from: number,
    to: number,
    count: number
  ): OriginLineState {
    const original = this.read(source)
    return replaceOriginCells(this.read(line), to, to + count, original, from)
  }

  copyFrom(line: OriginBufferLine, source: OriginBufferLine, blank?: boolean): void {
    const state = this.beforeCopy(source, blank)
    this.read(line)
    readOriginLineAttachment(line)!.originals!.copyFrom.call(line, source, blank)
    this.copied(line, state)
  }

  clone(line: OriginBufferLine, blank?: boolean): OriginBufferLine {
    const state = this.beforeCopy(line, blank)
    const result = readOriginLineAttachment(line)!.originals!.clone.call(line, blank)
    this.copied(result, state)
    return result
  }

  copyCells(
    line: OriginBufferLine,
    source: OriginBufferLine,
    from: number,
    to: number,
    count: number,
    reverse: boolean
  ): void {
    const state = this.beforeCells(line, source, from, to, count)
    readOriginLineAttachment(line)!.originals!.copyCellsFrom.call(
      line,
      source,
      from,
      to,
      count,
      reverse
    )
    this.copied(line, state)
  }
}
