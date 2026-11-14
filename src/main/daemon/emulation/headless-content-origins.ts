import type { Terminal } from '@xterm/headless'
import { HeadlessOriginCellSnapshots } from './headless-origin-cell-snapshots'
import { HeadlessOriginBuffers } from './headless-origin-buffers'
import { HeadlessOriginLineCopies } from './headless-origin-line-copies'
import { HeadlessOriginNativeObserver } from './headless-origin-native-observer'
import {
  captureOriginLineMethods,
  isNativeOriginLine,
  prepareOriginLineHookPrototype,
  ORIGIN_LINE_HOOKS,
  REQUIRED_ORIGIN_LINE_HOOKS
} from './headless-origin-line-hooks'
import { HeadlessOriginLineEdits } from './headless-origin-line-edits'
import {
  terminalOriginAt,
  terminalOriginSpan,
  writeTerminalOrigins,
  type TerminalOriginRuns,
  type TerminalContentOrigin
} from '../../../shared/terminal/output/terminal-content-origin'
import {
  readOriginScreenCache,
  originTerminalCore,
  readOriginLineAttachment,
  attachOriginLineState,
  type OriginLineAttachment,
  type OriginLineMethods,
  type OriginBufferLine,
  type OriginLineState,
  type OriginScreenCache
} from './headless-content-origin-lines'

/** Certificates follow the editor's actual line identities; no second screen or global patch. */
export class HeadlessContentOrigins {
  readonly cells = new HeadlessOriginCellSnapshots(
    (line) => this.state(line),
    (line, index, runs, component) => this.writeCell(line, index, runs, component),
    (state, index) => this.edits.erase(state, index)
  )
  readonly copies = new HeadlessOriginLineCopies(
    (line) => this.state(line),
    (line) => this.attachLine(line),
    (line, state) => this.assign(line, state)
  )
  private readonly observer = new HeadlessOriginNativeObserver(this)
  private nativeMethods?: Readonly<OriginLineMethods>
  private nativePrototype?: Readonly<OriginLineMethods>
  private sharedOriginals?: OriginLineMethods
  readonly edits = new HeadlessOriginLineEdits(
    (line) => this.state(line),
    (line, state) => this.assign(line, state)
  )
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
    originTerminalCore(terminal)?._bufferService?.installMutationObserver(this.observer)
    this.attachments = new HeadlessOriginBuffers(
      terminal,
      (line) => this.attachLine(line),
      () => this.revision++,
      () => this.flush()
    )
  }

  begin(origin?: TerminalContentOrigin): void {
    this.origin = origin
    this.revision++
  }

  end(): void {
    this.flush()
    this.origin = undefined
  }

  read(scope: TerminalContentOrigin): string[] {
    this.flush()
    this.cached = readOriginScreenCache(this.terminal, this, this.revision, scope, this.cached)
    return this.cached.lines
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

  flush(): void {
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

  printed(line: OriginBufferLine, index: number, width: number, code: number): void {
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

  codepointWritten(line: OriginBufferLine, index: number, code: number, width: number): void {
    const state = readOriginLineAttachment(line)!
    if (state.editing) {
      this.edits.erase(state, index)
    } else {
      this.printed(line, index, width, code)
    }
  }

  codepointCombined(
    line: OriginBufferLine,
    index: number,
    beforeLength: number,
    afterLength: number
  ): void {
    if (beforeLength === 0 && afterLength > 0) {
      this.writeCell(line, index, terminalOriginSpan(1, this.origin))
      return
    }
    const pending = this.pending
    if (
      pending?.line === line &&
      pending.start <= index &&
      index < pending.end &&
      pending.origin === this.origin
    ) {
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
      this.revision++
      return
    }
    const base = state.components?.get(index) ?? terminalOriginSpan(beforeLength, baseOrigin)
    let components = state.components
    const joined = writeTerminalOrigins(
      base,
      beforeLength,
      afterLength,
      terminalOriginSpan(afterLength - beforeLength, this.origin)
    )
    const uniform = this.origin
      ? joined.length === 1 && joined[0]!.start === 0 && joined[0]!.end === afterLength
      : joined.length === 0
    if (uniform) {
      components?.delete(index)
    } else {
      components ??= new Map()
      components.set(index, joined)
    }
    this.assign(line, { runs: state.runs, components })
  }

  writeCell(
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

  lineCreated(line: OriginBufferLine): void {
    if (readOriginLineAttachment(line)?.owner === this) {
      return
    }
    attachOriginLineState(line, { owner: this, runs: [], editing: false, recordSets: true })
  }

  lineAdmitted(
    line: OriginBufferLine,
    methods: Readonly<OriginLineMethods>,
    prototype: Readonly<OriginLineMethods>
  ): void {
    this.nativeMethods ??= methods
    this.nativePrototype ??= prototype
    this.attachLine(line)
  }

  private attachLine(line: OriginBufferLine): OriginBufferLine {
    if (readOriginLineAttachment(line)?.owner === this) {
      return line
    }
    line.mutationObserver = this.observer
    if (
      this.nativeMethods &&
      this.nativePrototype &&
      isNativeOriginLine(line, this.nativeMethods, this.nativePrototype)
    ) {
      line.structuralObserver = this.observer
      this.lineCreated(line)
      return line
    }
    const originals = captureOriginLineMethods(line, this.sharedOriginals)
    const hookPrototype = prepareOriginLineHookPrototype(line, originals)
    this.sharedOriginals ??= originals
    attachOriginLineState(line, {
      owner: this,
      originals,
      runs: [],
      editing: false,
      recordSets: true
    })
    line.structuralObserver = undefined
    if (hookPrototype) {
      Object.setPrototypeOf(line, hookPrototype)
    } else {
      Object.assign(line, originals.set ? ORIGIN_LINE_HOOKS : REQUIRED_ORIGIN_LINE_HOOKS)
    }
    return line
  }
}
