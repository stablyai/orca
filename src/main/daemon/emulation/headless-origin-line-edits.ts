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

/** Actual nested erasures stay on their row; outer edits own structural moves. */
export class HeadlessOriginLineEdits {
  constructor(
    private readonly read: (line: OriginBufferLine) => OriginLineAttachment,
    private readonly assign: (line: OriginBufferLine, state: OriginLineState) => void
  ) {}

  collect(state: OriginLineAttachment, index: number, codepoint: boolean): boolean {
    if (!state.editing) {
      return false
    }
    if (codepoint) {
      this.erase(state, index)
    }
    return true
  }

  erase(state: OriginLineAttachment, index: number): void {
    const erased = (state.erased ??= [])
    const last = erased.at(-1)
    if (last?.end === index) {
      last.end++
    } else {
      erased.push({ start: index, end: index + 1 })
    }
  }

  insert(line: OriginBufferLine, position: number, count: number, fill: OriginCell): void {
    this.shift(line, position, count, fill, true)
  }

  remove(line: OriginBufferLine, position: number, count: number, fill: OriginCell): void {
    this.shift(line, position, count, fill, false)
  }

  private shift(
    line: OriginBufferLine,
    position: number,
    count: number,
    fill: OriginCell,
    insert: boolean
  ): void {
    const state = this.read(line)
    const start = position % line.length
    const width = line.length
    const source = {
      runs: state.runs,
      components: state.components?.size ? new Map(state.components) : undefined
    }
    this.begin(state, false)
    try {
      if (insert) {
        state.originals.insertCells.call(line, position, count, fill)
      } else {
        state.originals.deleteCells.call(line, position, count, fill)
      }
    } finally {
      state.editing = false
      try {
        let next = replaceOriginCells(state, start, width)
        if (count < width - start) {
          next = insert
            ? replaceOriginCells(next, start + count, width, source, start)
            : replaceOriginCells(next, start, width - count, source, start + count)
        }
        this.finish(line, state, next)
      } finally {
        state.erased = undefined
      }
    }
  }

  replace(
    line: OriginBufferLine,
    start: number,
    end: number,
    fill: OriginCell,
    protect?: boolean
  ): void {
    const state = this.read(line)
    this.begin(state)
    try {
      state.originals.replaceCells.call(line, start, end, fill, protect)
    } finally {
      this.end(line, state)
    }
  }

  fill(line: OriginBufferLine, cell: OriginCell, protect?: boolean): void {
    const state = this.read(line)
    this.begin(state)
    try {
      state.originals.fill.call(line, cell, protect)
    } finally {
      this.end(line, state)
    }
  }

  resize(line: OriginBufferLine, cols: number, cell: OriginCell): boolean {
    const state = this.read(line)
    this.begin(state)
    try {
      return state.originals.resize.call(line, cols, cell)
    } finally {
      state.editing = false
      try {
        let components: OriginLineState['components']
        if (state.components?.size) {
          for (const [index, runs] of state.components) {
            if (index < cols) {
              components ??= new Map()
              components.set(index, runs)
            }
          }
        }
        this.finish(line, state, { runs: sliceTerminalOrigins(state.runs, 0, cols), components })
      } finally {
        state.erased = undefined
      }
    }
  }

  private begin(state: OriginLineAttachment, recordSets = true): void {
    state.recordSets = recordSets
    state.editing = true
    state.erased = undefined
  }

  private end(line: OriginBufferLine, state: OriginLineAttachment): void {
    state.editing = false
    try {
      this.finish(line, state, state)
    } finally {
      state.erased = undefined
    }
  }

  private finish(line: OriginBufferLine, state: OriginLineAttachment, next: OriginLineState): void {
    if (state.erased) {
      for (const span of state.erased) {
        next = replaceOriginCells(next, span.start, span.end)
      }
    }
    this.assign(line, next)
  }
}
