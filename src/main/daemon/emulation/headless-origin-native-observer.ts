import type { HeadlessContentOrigins } from './headless-content-origins'
import type {
  OriginBufferLine,
  OriginCell,
  OriginLineMethods,
  OriginLineState,
  OriginMutationObserver
} from './headless-content-origin-lines'
import type { OriginEditKind, OriginEditFrame } from './headless-origin-line-edits'
import type { OriginCellSnapshot } from './headless-origin-cell-snapshots'

/** The native producer reports actual mutations to the existing accounting owner. */
export class HeadlessOriginNativeObserver implements OriginMutationObserver {
  constructor(private readonly owner: HeadlessContentOrigins) {}

  codepointWritten(line: OriginBufferLine, column: number, code: number, width: number): void {
    this.owner.codepointWritten(line, column, code, width)
  }
  codepointCombined(line: OriginBufferLine, column: number, before: number, after: number): void {
    this.owner.codepointCombined(line, column, before, after)
  }
  lineCreated(line: OriginBufferLine): void {
    this.owner.lineCreated(line)
  }
  lineAdmitted(
    line: OriginBufferLine,
    methods: Readonly<OriginLineMethods>,
    prototype: Readonly<OriginLineMethods>
  ): void {
    this.owner.lineAdmitted(line, methods, prototype)
  }
  beforeLoad(line: OriginBufferLine): void {
    this.owner.cells.beforeLoad(line)
  }
  loaded(line: OriginBufferLine, column: number, cell: OriginCell): void {
    this.owner.cells.loaded(line, column, cell)
  }
  beforeSet(line: OriginBufferLine, cell: OriginCell): unknown {
    return this.owner.cells.beforeSet(line, cell)
  }
  cellSet(line: OriginBufferLine, column: number, snapshot: unknown): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native passes back only the synchronous beforeSet result from this observer.
    this.owner.cells.afterSet(line, column, snapshot as OriginCellSnapshot | undefined)
  }
  legacySet(line: OriginBufferLine, column: number): void {
    this.owner.writeCell(line, column)
  }
  beforeEdit(
    line: OriginBufferLine,
    kind: OriginEditKind,
    position: number,
    count: number
  ): unknown {
    return this.owner.edits.before(line, kind, position, count)
  }
  afterEdit(line: OriginBufferLine, frame: unknown): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native finally returns the stack-local frame created by this observer's beforeEdit.
    this.owner.edits.after(line, frame as OriginEditFrame)
  }
  beforeCopy(source: OriginBufferLine, blank?: boolean): unknown {
    return this.owner.copies.beforeCopy(source, blank)
  }
  beforeCells(
    line: OriginBufferLine,
    source: OriginBufferLine,
    from: number,
    to: number,
    count: number
  ): unknown {
    return this.owner.copies.beforeCells(line, source, from, to, count)
  }
  copied(line: OriginBufferLine, frame: unknown): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native returns the unchanged synchronous beforeCopy/beforeCells result to this observer.
    this.owner.copies.copied(line, frame as OriginLineState)
  }
  beforeBufferChange(): void {
    this.owner.flush()
  }
  afterBufferChange(): void {
    this.owner.resized()
  }
}
