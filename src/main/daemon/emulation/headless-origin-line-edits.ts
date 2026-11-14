import {
  sliceTerminalOrigins,
  writeTerminalOrigins,
  type TerminalOriginRuns
} from '../../../shared/terminal/output/terminal-content-origin'
import type { OriginBufferLine, OriginLineState } from './headless-content-origin-lines'

export function replaceOriginCells(
  target: OriginLineState,
  start: number,
  end: number,
  source?: OriginLineState,
  from = 0
): OriginLineState {
  const copied: [number, TerminalOriginRuns][] = []
  for (let index = from; source?.components.size && index < from + end - start; index++) {
    const runs = source.components.get(index)
    if (runs) {
      copied.push([index - from + start, runs])
    }
  }
  const components = target.components
  if (components.size) {
    for (let index = start; index < end; index++) {
      components.delete(index)
    }
  }
  for (const [index, runs] of copied) {
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

/** Nested setters report only actual erasures; the outer edit owns shifts and protected cells. */
export class HeadlessOriginLineEdits {
  private editing = false
  private recordSets = true
  private erased: { start: number; end: number }[] = []

  constructor(
    private readonly read: () => OriginLineState,
    private readonly assign: (state: OriginLineState) => void
  ) {}

  get active(): boolean {
    return this.editing
  }

  collect(index: number, codepoint: boolean): boolean {
    if (!this.editing) {
      return false
    }
    if (codepoint) {
      this.erase(index)
    }
    return true
  }

  private erase(index: number): void {
    const last = this.erased.at(-1)
    if (last?.end === index) {
      last.end++
    } else {
      this.erased.push({ start: index, end: index + 1 })
    }
  }

  attach(line: OriginBufferLine): void {
    const run = <T>(
      operation: () => T,
      transform: (before: OriginLineState) => OriginLineState,
      recordSets = true
    ): T => {
      const before = this.read()
      this.recordSets = recordSets
      this.editing = true
      this.erased = []
      try {
        return operation()
      } finally {
        this.editing = false
        let next = transform(before)
        for (const span of this.erased) {
          next = replaceOriginCells(next, span.start, span.end)
        }
        this.assign(next)
        this.erased = []
      }
    }
    const insert = line.insertCells
    line.insertCells = (position, count, fill) => {
      const start = position % line.length
      const width = line.length
      run(
        () => insert.call(line, position, count, fill),
        (before) => {
          const source = { runs: before.runs, components: new Map(before.components) }
          let next = replaceOriginCells(before, start, width)
          if (count < width - start) {
            next = replaceOriginCells(next, start + count, width, source, start)
          }
          return next
        },
        false
      )
    }
    const remove = line.deleteCells
    line.deleteCells = (position, count, fill) => {
      const start = position % line.length
      const width = line.length
      run(
        () => remove.call(line, position, count, fill),
        (before) => {
          const source = { runs: before.runs, components: new Map(before.components) }
          let next = replaceOriginCells(before, start, width)
          if (count < width - start) {
            next = replaceOriginCells(next, start, width - count, source, start + count)
          }
          return next
        },
        false
      )
    }
    const replace = line.replaceCells
    line.replaceCells = (start, end, fill, protect) => {
      run(
        () => replace.call(line, start, end, fill, protect),
        (before) => before
      )
    }
    const fill = line.fill
    line.fill = (cell, protect) => {
      run(
        () => fill.call(line, cell, protect),
        (before) => before
      )
    }
    const resize = line.resize
    line.resize = (cols, cell) =>
      run(
        () => resize.call(line, cols, cell),
        (before) => ({
          runs: sliceTerminalOrigins(before.runs, 0, cols),
          components: new Map([...before.components].filter(([index]) => index < cols))
        })
      )
    const set = line.setCell
    line.setCell = (index, cell) => {
      set.call(line, index, cell)
      // Fill/replace skip protected columns, so collect the actual nested footprint.
      if (this.editing && this.recordSets) {
        this.erase(index)
      }
    }
  }
}
