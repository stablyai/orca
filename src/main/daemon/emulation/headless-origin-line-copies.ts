import {
  readOriginLineAttachment,
  type OriginBufferLine,
  type OriginLineAttachment,
  type OriginLineState
} from './headless-content-origin-lines'
import { replaceOriginCells } from './headless-origin-line-edits'

/** Cold copy operations use the owner's existing attribution and lifetime. */
export class HeadlessOriginLineCopies {
  constructor(
    private readonly read: (line: OriginBufferLine) => OriginLineAttachment,
    private readonly attach: (line: OriginBufferLine) => OriginBufferLine,
    private readonly assign: (line: OriginBufferLine, state: OriginLineState) => void,
    private readonly emptyClone: (line: OriginBufferLine) => boolean
  ) {}

  copyFrom(line: OriginBufferLine, source: OriginBufferLine, blank?: boolean): void {
    readOriginLineAttachment(source)?.owner.materialize()
    const state = this.read(source)
    this.read(line)
    readOriginLineAttachment(line)!.originals.copyFrom.call(line, source, blank)
    this.assign(line, {
      runs: state.runs,
      components: !blank && state.components?.size ? new Map(state.components) : undefined
    })
  }

  clone(line: OriginBufferLine, blank?: boolean): OriginBufferLine {
    const original = readOriginLineAttachment(line)!.originals.clone
    if (blank && this.emptyClone(line)) {
      return this.attach(original.call(line, blank))
    }
    const state = this.read(line)
    const result = this.attach(original.call(line, blank))
    this.assign(result, {
      runs: state.runs,
      components: !blank && state.components?.size ? new Map(state.components) : undefined
    })
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
    readOriginLineAttachment(source)?.owner.materialize()
    const original = this.read(source)
    const target = this.read(line)
    const next = replaceOriginCells(target, to, to + count, original, from)
    target.originals.copyCellsFrom.call(line, source, from, to, count, reverse)
    this.assign(line, next)
  }
}
