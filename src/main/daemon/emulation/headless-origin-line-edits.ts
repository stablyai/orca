import {
  sliceTerminalOrigins,
  writeTerminalOrigins,
  type TerminalOriginRuns
} from '../../../shared/terminal/output/terminal-content-origin'
import type {
  OriginBufferLine,
  OriginLineState,
  OriginLineAttachment,
  OriginCell
} from './headless-content-origin-lines'

export function replaceOriginCells(
  target: OriginLineState,
  start: number,
  end: number,
  source?: OriginLineState,
  from = 0
): OriginLineState {
  const copied: [number, TerminalOriginRuns][] = []
  for (let index = from; source?.components?.size && index < from + end - start; index++) {
    const runs = source.components.get(index)
    if (runs) {
      copied.push([index - from + start, runs])
    }
  }
  let components = target.components
  if (components?.size) {
    for (let index = start; index < end; index++) {
      components.delete(index)
    }
  }
  for (const [index, runs] of copied) {
    components ??= new Map()
    components.set(index, runs)
  }
  return {
    runs: writeTerminalOrigins(
      target.runs,
      start,
      end,
      sliceTerminalOrigins(source?.runs, from, from + end - start)
    ),
    components
  }
}

export type OriginEditKind = 'insert' | 'delete' | 'replace' | 'fill' | 'resize'
export type OriginEditFrame = {
  state: OriginLineAttachment
  kind: OriginEditKind
  start: number
  count: number
  width: number
  source?: OriginLineState
}

/** Native events and custom wrappers share the same accounting. */
export class HeadlessOriginLineEdits {
  constructor(
    private readonly read: (line: OriginBufferLine) => OriginLineAttachment,
    private readonly assign: (line: OriginBufferLine, state: OriginLineState) => void
  ) {}

  erase(state: OriginLineAttachment, index: number): void {
    const erased = (state.erased ??= [])
    const last = erased.at(-1)
    if (last?.end === index) {
      last.end++
    } else {
      erased.push({ start: index, end: index + 1 })
    }
  }

  before(line: OriginBufferLine, kind: OriginEditKind, position = 0, count = 0): OriginEditFrame {
    const state = this.read(line)
    const shift = kind === 'insert' || kind === 'delete'
    const frame = {
      state,
      kind,
      start: position % line.length,
      count,
      width: line.length,
      source: shift
        ? {
            runs: state.runs,
            components: state.components?.size ? new Map(state.components) : undefined
          }
        : undefined
    }
    state.recordSets = !shift
    state.editing = true
    state.erased = undefined
    return frame
  }

  after(line: OriginBufferLine, frame: OriginEditFrame): void {
    const { state, kind, start, count, width, source } = frame
    state.editing = false
    try {
      let next: OriginLineState = state
      if (kind === 'insert' || kind === 'delete') {
        next = replaceOriginCells(state, start, width)
        if (count < width - start) {
          next =
            kind === 'insert'
              ? replaceOriginCells(next, start + count, width, source, start)
              : replaceOriginCells(next, start, width - count, source, start + count)
        }
      } else if (kind === 'resize') {
        let components: OriginLineState['components']
        if (state.components?.size) {
          for (const [index, runs] of state.components) {
            if (index < line.length) {
              components ??= new Map()
              components.set(index, runs)
            }
          }
        }
        next = { runs: sliceTerminalOrigins(state.runs, 0, line.length), components }
      }
      if (state.erased) {
        for (const span of state.erased) {
          next = replaceOriginCells(next, span.start, span.end)
        }
      }
      this.assign(line, next)
    } finally {
      state.erased = undefined
    }
  }

  insert(line: OriginBufferLine, position: number, count: number, fill: OriginCell): void {
    const frame = this.before(line, 'insert', position, count)
    try {
      frame.state.originals!.insertCells.call(line, position, count, fill)
    } finally {
      this.after(line, frame)
    }
  }

  remove(line: OriginBufferLine, position: number, count: number, fill: OriginCell): void {
    const frame = this.before(line, 'delete', position, count)
    try {
      frame.state.originals!.deleteCells.call(line, position, count, fill)
    } finally {
      this.after(line, frame)
    }
  }

  replace(
    line: OriginBufferLine,
    start: number,
    end: number,
    fill: OriginCell,
    protect?: boolean
  ): void {
    const frame = this.before(line, 'replace')
    try {
      frame.state.originals!.replaceCells.call(line, start, end, fill, protect)
    } finally {
      this.after(line, frame)
    }
  }

  fill(line: OriginBufferLine, cell: OriginCell, protect?: boolean): void {
    const frame = this.before(line, 'fill')
    try {
      frame.state.originals!.fill.call(line, cell, protect)
    } finally {
      this.after(line, frame)
    }
  }

  resize(line: OriginBufferLine, cols: number, cell: OriginCell): boolean {
    const frame = this.before(line, 'resize')
    try {
      return frame.state.originals!.resize.call(line, cols, cell)
    } finally {
      this.after(line, frame)
    }
  }
}
