import type { Terminal } from '@xterm/headless'
import { HeadlessOriginBuffers } from './headless-origin-buffers'
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
  type OriginBufferLine,
  type OriginCell,
  type OriginLineState,
  type OriginScreenCache
} from './headless-content-origin-lines'

/** Certificates follow the editor's actual line identities; no second screen or global patch. */
export class HeadlessContentOrigins {
  private readonly lines = new WeakMap<OriginBufferLine, OriginLineState>()
  private readonly cells = new WeakMap<
    OriginCell,
    {
      runs: TerminalOriginRuns
      index: number
      component?: TerminalOriginRuns
    }
  >()
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
    const lines = readOriginScreenLines(this.terminal, this.lines)
    this.cached = { revision: this.revision, scope, lines }
    return lines
  }

  resized(): void {
    this.revision++
    this.attachments.attach()
  }

  private state(line: OriginBufferLine): OriginLineState {
    this.flush()
    this.attachLine(line)
    return this.lines.get(line)!
  }

  private assign(line: OriginBufferLine, state: OriginLineState): void {
    this.lines.set(line, state)
    this.revision++
  }

  private flush(): void {
    const pending = this.pending
    if (!pending) {
      return
    }
    this.pending = undefined
    const state = this.lines.get(pending.line)!
    const components = state.components
    for (let index = pending.start; index < pending.end; index++) {
      components.delete(index)
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

  private writeCell(line: OriginBufferLine, index: number, state?: OriginLineState): void {
    const previous = this.state(line)
    const components = previous.components
    const copied = state?.components.get(0)
    components.delete(index)
    if (copied) {
      components.set(index, copied)
    }
    this.assign(line, {
      runs: writeTerminalOrigins(
        previous.runs,
        index,
        index + 1,
        state?.runs ?? terminalOriginSpan(1, line.getString(index) ? this.origin : undefined)
      ),
      components
    })
  }

  private attachLine(line: OriginBufferLine): OriginBufferLine {
    if (this.lines.has(line)) {
      return line
    }
    this.lines.set(line, { runs: [], components: new Map() })
    const edits = new HeadlessOriginLineEdits(
      () => this.state(line),
      (state) => this.assign(line, state)
    )
    const load = line.loadCell
    line.loadCell = (index, cell) => {
      const result = load.call(line, index, cell)
      if (edits.active) {
        return result
      }
      const state = this.state(line)
      const snapshot = this.cells.get(result)
      if (snapshot) {
        snapshot.runs = state.runs
        snapshot.index = index
        snapshot.component = state.components.get(index)
      } else {
        this.cells.set(result, {
          runs: state.runs,
          index,
          component: state.components.get(index)
        })
      }
      return result
    }
    const set = line.setCell
    line.setCell = (index, cell) => {
      const origin = this.cells.get(cell)
      set.call(line, index, cell)
      if (!edits.collect(index, false)) {
        this.writeCell(line, index, {
          runs: origin ? terminalOriginSpan(1, terminalOriginAt(origin.runs, origin.index)) : [],
          components: origin?.component ? new Map([[0, origin.component]]) : new Map()
        })
      }
    }
    const print = line.setCellFromCodepoint
    line.setCellFromCodepoint = (index, code, width, attrs) => {
      print.call(line, index, code, width, attrs)
      if (!edits.collect(index, true)) {
        this.printed(line, index, width, code)
      }
    }
    const setData = line.set
    if (setData) {
      line.set = (index, cell) => {
        setData.call(line, index, cell)
        this.writeCell(line, index)
      }
    }
    const combine = line.addCodepointToCell
    line.addCodepointToCell = (index, code, width) => {
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
        !state.components.has(index) &&
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
        state.components.get(index) ??
        terminalOriginSpan(before.length, terminalOriginAt(state.runs, index))
      combine.call(line, index, code, width)
      const components = state.components
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
        components.delete(index)
      } else {
        components.set(index, joined)
      }
      this.assign(line, { runs: state.runs, components })
    }
    const copy = line.copyFrom
    line.copyFrom = (source, blank) => {
      const state = this.state(source)
      copy.call(line, source, blank)
      this.assign(line, {
        runs: state.runs,
        components: blank ? new Map() : new Map(state.components)
      })
    }
    const clone = line.clone
    line.clone = (blank) => {
      const result = this.attachLine(clone.call(line, blank))
      const state = this.state(line)
      this.assign(result, {
        runs: state.runs,
        components: blank ? new Map() : new Map(state.components)
      })
      return result
    }
    const copyCells = line.copyCellsFrom
    line.copyCellsFrom = (source, from, to, count, reverse) => {
      const original = this.state(source)
      const target = this.state(line)
      const next = replaceOriginCells(target, to, to + count, original, from)
      copyCells.call(line, source, from, to, count, reverse)
      this.assign(line, next)
    }
    edits.attach(line)
    return line
  }
}
