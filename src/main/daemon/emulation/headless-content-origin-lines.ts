import type { IBufferCell, Terminal } from '@xterm/headless'
import type { HeadlessContentOrigins } from './headless-content-origins'
import {
  getTerminalLineOrigins,
  setTerminalLineOrigins,
  sliceTerminalOrigins,
  type TerminalContentOrigin,
  type TerminalOriginRun,
  type TerminalOriginRuns
} from '../../../shared/terminal/output/terminal-content-origin'

export type OriginCell = IBufferCell
type OriginCellAttributes = { fg?: number; bg?: number }
export type OriginBufferLine = {
  mutationObserver?: Pick<
    HeadlessContentOrigins,
    'codepointWritten' | 'codepointCombined' | 'glyphNotificationsEnabled' | 'materialize'
  >
  length: number
  getString(index: number): string
  hasContent(index: number): number
  getWidth(index: number): number
  translateToString(trim?: boolean, start?: number, end?: number, columns?: number[]): string
  loadCell(index: number, cell: OriginCell): OriginCell
  setCell(index: number, cell: OriginCell): void
  setCellFromCodepoint(
    index: number,
    code: number,
    width: number,
    attrs: OriginCellAttributes
  ): void
  addCodepointToCell(index: number, code: number, width: number): void
  set(index: number, cell: [number, string, number, number]): void
  insertCells(pos: number, count: number, cell: OriginCell): void
  deleteCells(pos: number, count: number, cell: OriginCell): void
  replaceCells(start: number, end: number, cell: OriginCell, protect?: boolean): void
  fill(cell: OriginCell, protect?: boolean): void
  resize(cols: number, cell: OriginCell): boolean
  copyFrom(line: OriginBufferLine, blank?: boolean): void
  clone(blank?: boolean): OriginBufferLine
  copyCellsFrom(
    line: OriginBufferLine,
    from: number,
    to: number,
    count: number,
    reverse: boolean
  ): void
}
export type OriginLineList = {
  length: number
  maxLength?: number
  get(index: number): OriginBufferLine | undefined
  set(index: number, line: OriginBufferLine): void
  push(line: OriginBufferLine): void
  splice(start: number, count: number, ...lines: OriginBufferLine[]): void
  shiftElements(start: number, count: number, offset: number): void
  trimStart(count: number): void
  pop(): OriginBufferLine | undefined
  recycle(): OriginBufferLine
}
export type OriginBuffer = {
  lines: OriginLineList
  getNullCell(...args: unknown[]): OriginCell
  getBlankLine(...args: unknown[]): OriginBufferLine
  clear(...args: unknown[]): void
}
export type OriginTerminalCore = {
  buffers: { normal: OriginBuffer; alt: OriginBuffer; active: OriginBuffer }
  reset(...args: unknown[]): void
}
export function originTerminalCore(terminal: Terminal): OriginTerminalCore | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: optional installed-xterm instance seam, checked before use.
  return (terminal as unknown as { _core?: OriginTerminalCore })._core
}

export type OriginLineState = {
  runs: TerminalOriginRuns
  components?: Map<number, TerminalOriginRuns>
}

export type OriginLineMethods = Pick<
  OriginBufferLine,
  | 'loadCell'
  | 'setCell'
  | 'set'
  | 'insertCells'
  | 'deleteCells'
  | 'replaceCells'
  | 'fill'
  | 'resize'
  | 'copyFrom'
  | 'clone'
  | 'copyCellsFrom'
>
export type OriginLineAttachment = OriginLineState & {
  owner: HeadlessContentOrigins
  originals: OriginLineMethods
  editing: boolean
  recordSets: boolean
  erased?: { start: number; end: number }[]
}
const ORIGIN_LINE_ATTACHMENT = Symbol('terminalContentOrigin')

export function readOriginLineAttachment(line: OriginBufferLine): OriginLineAttachment | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this module owns the private editor attachment symbol.
  return (line as OriginBufferLine & { [ORIGIN_LINE_ATTACHMENT]?: OriginLineAttachment })[
    ORIGIN_LINE_ATTACHMENT
  ]
}

export function attachOriginLineState(line: OriginBufferLine, state: OriginLineAttachment): void {
  Object.defineProperty(line, ORIGIN_LINE_ATTACHMENT, { value: state, configurable: true })
}

/** Build coordinates from xterm's own translation, including wide and combined glyphs. */
export function readOriginScreenLines(terminal: Terminal, owner: HeadlessContentOrigins): string[] {
  const core = originTerminalCore(terminal)
  const buffer = terminal.buffer.active
  const lines: string[] = []
  const origins: TerminalOriginRuns[] = []
  const uniform = owner.uniformOrigin
  for (let index = buffer.viewportY; index < buffer.viewportY + terminal.rows; index++) {
    const line = core?.buffers.active.lines.get(index)
    const columns: number[] = []
    const text = line?.translateToString(true, 0, undefined, columns) ?? ''
    const attached = line ? readOriginLineAttachment(line) : undefined
    const state = attached?.owner === owner ? attached : undefined
    const runs: TerminalOriginRun[] = []
    const append = (start: number, end: number, origin: TerminalContentOrigin): void => {
      const previous = runs.at(-1)
      if (
        previous?.end === start &&
        previous.origin.owner === origin.owner &&
        previous.origin.epoch === origin.epoch
      ) {
        previous.end = end
      } else if (end > start) {
        runs.push({ start, end, origin })
      }
    }
    let sourceIndex = 0
    let at = 0
    while (at < text.length) {
      const column = columns[at]!
      let end = at + 1
      while (end < text.length && columns[end] === column) {
        end++
      }
      const component = state?.components?.get(column)
      if (component) {
        for (const run of component) {
          append(at + run.start, Math.min(end, at + run.end), run.origin)
        }
      } else if (uniform && state && line?.hasContent(column)) {
        append(at, end, uniform)
      } else if (line?.hasContent(column)) {
        while (state?.runs[sourceIndex] && state.runs[sourceIndex]!.end <= column) {
          sourceIndex++
        }
        const run = state?.runs[sourceIndex]
        if (run && run.start <= column) {
          append(at, end, run.origin)
        }
      }
      at = end
    }
    lines.push(text)
    origins.push(runs)
  }
  setTerminalLineOrigins(lines, origins)
  return lines
}

/** Preserve certificates through a projection that only trims and omits blank rows. */
export function carryOriginScreenLines(source: readonly string[], lines: string[]): void {
  const origins = getTerminalLineOrigins(source)
  if (!origins) {
    return
  }
  let index = 0
  const kept: TerminalOriginRuns[] = []
  for (const line of lines) {
    while (index < source.length && !source[index]!.trim()) {
      index++
    }
    const raw = source[index] ?? ''
    const start = raw.indexOf(line)
    kept.push(start === -1 ? [] : sliceTerminalOrigins(origins[index], start, start + line.length))
    index++
  }
  setTerminalLineOrigins(lines, kept)
}

export type OriginScreenCache = { revision: number; scope: TerminalContentOrigin; lines: string[] }

export function readOriginScreenCache(
  terminal: Terminal,
  owner: HeadlessContentOrigins,
  revision: number,
  scope: TerminalContentOrigin,
  cached?: OriginScreenCache
): OriginScreenCache {
  if (
    cached?.revision === revision &&
    cached.scope.owner === scope.owner &&
    cached.scope.epoch === scope.epoch
  ) {
    return cached
  }
  return { revision, scope, lines: readOriginScreenLines(terminal, owner) }
}
