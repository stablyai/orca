import type { Terminal } from '@xterm/headless'
import { HeadlessOriginCellSnapshots } from './headless-origin-cell-snapshots'
import { HeadlessOriginBuffers } from './headless-origin-buffers'
import { captureOriginLineMethods, createOriginLineHooks } from './headless-origin-line-hooks'
import { HeadlessOriginLineEdits, replaceOriginCells } from './headless-origin-line-edits'
import {
  terminalOriginAt,
  terminalOriginSpan,
  writeTerminalOrigins,
  type TerminalOriginRuns,
  type TerminalContentOrigin
} from '../../../shared/terminal/output/terminal-content-origin'
import {
  readOriginScreenLines,
  readOriginLineAttachment,
  attachOriginLineState,
  type OriginLineAttachment,
  type OriginLineMethods,
  type OriginBufferLine,
  type OriginCell,
  type OriginLineState,
  type OriginScreenCache
} from './headless-content-origin-lines'

/** Certificates follow the editor's actual line identities; no second screen or global patch. */
export class HeadlessContentOrigins {
  private readonly cells = new HeadlessOriginCellSnapshots((line) => this.state(line))
  private sharedOriginals?: OriginLineMethods
  private readonly edits = new HeadlessOriginLineEdits(
    (line) => this.state(line),
    (line, state) => this.assign(line, state)
  )
  private readonly hooks = createOriginLineHooks({
    loadCell: (line, index, cell) => this.cells.load(line, index, cell),
    setCell: (line, index, cell) => this.setCell(line, index, cell),
    setCellFromCodepoint: (line, index, code, width, attrs) => {
      const state = readOriginLineAttachment(line)!
      state.originals.setCellFromCodepoint.call(line, index, code, width, attrs)
      if (!this.edits.collect(state, index, true)) {
        this.printed(line, index, width, code)
      }
    },
    addCodepointToCell: (line, index, code, width) => this.combined(line, index, code, width),
    set: (line, index, cell) => {
      readOriginLineAttachment(line)!.originals.set.call(line, index, cell)
      this.writeCell(line, index)
    },
    insertCells: (line, position, count, fill) => this.edits.insert(line, position, count, fill),
    deleteCells: (line, position, count, fill) => this.edits.remove(line, position, count, fill),
    replaceCells: (line, start, end, fill, protect) =>
      this.edits.replace(line, start, end, fill, protect),
    fill: (line, cell, protect) => this.edits.fill(line, cell, protect),
    resize: (line, cols, cell) => this.edits.resize(line, cols, cell),
    copyFrom: (line, source, blank) => this.copyFrom(line, source, blank),
    clone: (line, blank) => this.clone(line, blank),
    copyCellsFrom: (line, source, from, to, count, reverse) =>
      this.copyCells(line, source, from, to, count, reverse)
  })
  private readonly requiredHooks = (({ set: _set, ...hooks }) => hooks)(this.hooks)
  private readonly attachments: HeadlessOriginBuffers
  private pending?: {
    line: OriginBufferLine
    start: number
    end: number
    origin?: TerminalContentOrigin
  }
  private origin: TerminalContentOrigin | undefined
  private revision = 0
  private cached?: OriginScreenCache

  constructor(private readonly terminal: Terminal) {
    this.attachments = new HeadlessOriginBuffers(
      terminal,
      (line) => this.attachLine(line),
      () => this.revision++
    )
  }

  begin(origin?: TerminalContentOrigin): void {
    this.origin = origin
    this.revision++
    this.attachments.attach()
  }

  end(): void {
    this.flush()
    this.origin = undefined
  }

  read(scope: TerminalContentOrigin): string[] {
    this.flush()
    const cached = this.cached
    if (
      cached?.revision === this.revision &&
      cached.scope.owner === scope.owner &&
      cached.scope.epoch === scope.epoch
    ) {
      return cached.lines
    }
    const lines = readOriginScreenLines(this.terminal, this)
    this.cached = { revision: this.revision, scope, lines }
    return lines
  }

  resized(): void {
    this.revision++
    this.attachments.attach()
  }

  private state(line: OriginBufferLine): OriginLineAttachment {
    this.flush()
    this.attachLine(line)
    return readOriginLineAttachment(line)!
  }

  private assign(line: OriginBufferLine, state: OriginLineState): void {
    const attached = readOriginLineAttachment(line)!
    attached.runs = state.runs
    attached.components = state.components?.size ? state.components : undefined
    this.revision++
  }

  private flush(): void {
    const pending = this.pending
    if (!pending) {
      return
    }
    this.pending = undefined
    const state = readOriginLineAttachment(pending.line)!
    const components = state.components
    if (components?.size) {
      for (let index = pending.start; index < pending.end; index++) {
        components.delete(index)
      }
    }
    this.assign(pending.line, {
      runs: writeTerminalOrigins(
        state.runs,
        pending.start,
        pending.end,
        terminalOriginSpan(pending.end - pending.start, pending.origin)
      ),
      components
    })
  }

  private printed(line: OriginBufferLine, index: number, width: number, code: number): void {
    if (width === 0) {
      return
    }
    const origin = code ? this.origin : undefined
    const pending = this.pending
    if (pending?.line === line && pending.end === index && pending.origin === origin) {
      pending.end += width
    } else {
      this.flush()
      this.pending = { line, start: index, end: index + width, origin }
    }
  }

  private combined(line: OriginBufferLine, index: number, code: number, width: number): void {
    const combine = readOriginLineAttachment(line)!.originals.addCodepointToCell
    const pending = this.pending
    if (
      pending?.line === line &&
      pending.start <= index &&
      index < pending.end &&
      pending.origin === this.origin
    ) {
      combine.call(line, index, code, width)
      return
    }
    const state = this.state(line)
    const baseOrigin = terminalOriginAt(state.runs, index)
    if (
      !state.components?.has(index) &&
      (baseOrigin === this.origin ||
        (baseOrigin &&
          this.origin &&
          baseOrigin.owner === this.origin.owner &&
          baseOrigin.epoch === this.origin.epoch))
    ) {
      combine.call(line, index, code, width)
      this.revision++
      return
    }
    const before = line.getString(index)
    const base =
      state.components?.get(index) ??
      terminalOriginSpan(before.length, terminalOriginAt(state.runs, index))
    combine.call(line, index, code, width)
    let components = state.components
    const after = line.getString(index)
    const joined = writeTerminalOrigins(
      base,
      before.length,
      after.length,
      terminalOriginSpan(after.length - before.length, this.origin)
    )
    const uniform = this.origin
      ? joined.length === 1 && joined[0]!.start === 0 && joined[0]!.end === after.length
      : joined.length === 0
    if (uniform) {
      components?.delete(index)
    } else {
      components ??= new Map()
      components.set(index, joined)
    }
    this.assign(line, { runs: state.runs, components })
  }

  private writeCell(
    line: OriginBufferLine,
    index: number,
    runs?: TerminalOriginRuns,
    component?: TerminalOriginRuns
  ): void {
    const previous = this.state(line)
    let components = previous.components
    components?.delete(index)
    if (component) {
      components ??= new Map()
      components.set(index, component)
    }
    this.assign(line, {
      runs: writeTerminalOrigins(
        previous.runs,
        index,
        index + 1,
        runs ?? terminalOriginSpan(1, line.getString(index) ? this.origin : undefined)
      ),
      components
    })
  }

  private setCell(line: OriginBufferLine, index: number, cell: OriginCell): void {
    const state = readOriginLineAttachment(line)!
    const origin = this.cells.get(cell)
    state.originals.setCell.call(line, index, cell)
    if (state.editing) {
      if (state.recordSets) {
        this.edits.erase(state, index)
      }
    } else {
      this.writeCell(
        line,
        index,
        origin ? terminalOriginSpan(1, terminalOriginAt(origin.runs, origin.index)) : [],
        origin?.component
      )
    }
  }

  private copyFrom(line: OriginBufferLine, source: OriginBufferLine, blank?: boolean): void {
    const state = this.state(source)
    readOriginLineAttachment(line)!.originals.copyFrom.call(line, source, blank)
    this.assign(line, {
      runs: state.runs,
      components: !blank && state.components?.size ? new Map(state.components) : undefined
    })
  }

  private clone(line: OriginBufferLine, blank?: boolean): OriginBufferLine {
    const result = this.attachLine(
      readOriginLineAttachment(line)!.originals.clone.call(line, blank)
    )
    const state = this.state(line)
    this.assign(result, {
      runs: state.runs,
      components: !blank && state.components?.size ? new Map(state.components) : undefined
    })
    return result
  }

  private copyCells(
    line: OriginBufferLine,
    source: OriginBufferLine,
    from: number,
    to: number,
    count: number,
    reverse: boolean
  ): void {
    const original = this.state(source)
    const target = this.state(line)
    const next = replaceOriginCells(target, to, to + count, original, from)
    target.originals.copyCellsFrom.call(line, source, from, to, count, reverse)
    this.assign(line, next)
  }

  private attachLine(line: OriginBufferLine): OriginBufferLine {
    if (readOriginLineAttachment(line)?.owner === this) {
      return line
    }
    const originals = captureOriginLineMethods(line, this.sharedOriginals)
    this.sharedOriginals ??= originals
    attachOriginLineState(line, {
      owner: this,
      originals,
      runs: [],
      editing: false,
      recordSets: true
    })
    Object.assign(line, originals.set ? this.hooks : this.requiredHooks)
    return line
  }
}
