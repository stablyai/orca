import { cellWidth, clipAnsi, sliceCellsFrom } from './text-width'
import type { LogicalKey } from './tty-key-adapter'

const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'

/** Per-line transform (e.g. syntax highlighting) applied before the cursor cell. */
export type LineDecorator = (line: string) => string
const identity: LineDecorator = (line) => line

/** An in-memory text buffer with a cursor, for the read/write file view. Pure
 *  editing logic (no I/O): the pane owns load/save via files.read/files.write. */
export class FileEditor {
  private lines: string[] = ['']
  private row = 0
  private col = 0
  private baseline = ''

  load(content: string): void {
    this.lines = content.length === 0 ? [''] : content.split('\n')
    this.baseline = content
    this.row = 0
    this.col = 0
  }

  get content(): string {
    return this.lines.join('\n')
  }

  get dirty(): boolean {
    return this.content !== this.baseline
  }

  /** The content as of the last load/save — for detecting external changes. */
  get savedContent(): string {
    return this.baseline
  }

  get cursorRow(): number {
    return this.row
  }

  get lineCount(): number {
    return this.lines.length
  }

  markSaved(): void {
    this.baseline = this.content
  }

  revert(): void {
    this.load(this.baseline)
  }

  /** Place the cursor at a buffer (row, col index), clamped into range. */
  setCursor(row: number, col: number): void {
    this.row = Math.min(Math.max(row, 0), this.lines.length - 1)
    this.col = Math.min(Math.max(col, 0), this.lines[this.row].length)
  }

  /** Place the cursor from a click at a visible (row, cell-column): walk the
   *  line by display width so wide/CJK/emoji glyphs map to the right index. */
  setCursorFromClick(row: number, cellCol: number): void {
    this.row = Math.min(Math.max(row, 0), this.lines.length - 1)
    const line = this.lines[this.row]
    let i = 0
    let cells = 0
    while (i < line.length && cells < cellCol) {
      const ch = String.fromCodePoint(line.codePointAt(i) ?? 0)
      cells += cellWidth(ch)
      i += ch.length
    }
    this.col = i
  }

  /** Apply an editing key; returns true if it changed the buffer or cursor. */
  handleKey(key: LogicalKey): boolean {
    if (key.type === 'char') {
      this.insert(key.value)
    } else if (key.type === 'tab') {
      this.insert('  ')
    } else if (key.type === 'enter') {
      this.newline()
    } else if (key.type === 'backspace') {
      this.backspace()
    } else if (
      key.type === 'up' ||
      key.type === 'down' ||
      key.type === 'left' ||
      key.type === 'right'
    ) {
      this.move(key.type)
    } else {
      return false
    }
    return true
  }

  private insert(text: string): void {
    const line = this.lines[this.row]
    this.lines[this.row] = line.slice(0, this.col) + text + line.slice(this.col)
    this.col += text.length
  }

  private newline(): void {
    const line = this.lines[this.row]
    this.lines.splice(this.row, 1, line.slice(0, this.col), line.slice(this.col))
    this.row += 1
    this.col = 0
  }

  // Step/scan by Unicode code points so the cursor never lands inside a
  // surrogate pair (astral chars are 2 UTF-16 units; insert moves by 2).
  private prevCol(line: string, col: number): number {
    if (col <= 0) {
      return 0
    }
    const cp = line.codePointAt(col - 1) ?? 0
    return col - (cp > 0xffff ? 2 : 1)
  }

  private nextCol(line: string, col: number): number {
    if (col >= line.length) {
      return line.length
    }
    const cp = line.codePointAt(col) ?? 0
    return Math.min(line.length, col + (cp > 0xffff ? 2 : 1))
  }

  private charAtCol(line: string, col: number): string {
    if (col >= line.length) {
      return ' '
    }
    return String.fromCodePoint(line.codePointAt(col) ?? 0x20)
  }

  private backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row]
      const start = this.prevCol(line, this.col)
      this.lines[this.row] = line.slice(0, start) + line.slice(this.col)
      this.col = start
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1]
      this.col = prev.length
      this.lines[this.row - 1] = prev + this.lines[this.row]
      this.lines.splice(this.row, 1)
      this.row -= 1
    }
  }

  private move(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (dir === 'left') {
      if (this.col > 0) {
        this.col = this.prevCol(this.lines[this.row], this.col)
      } else if (this.row > 0) {
        this.row -= 1
        this.col = this.lines[this.row].length
      }
    } else if (dir === 'right') {
      if (this.col < this.lines[this.row].length) {
        this.col = this.nextCol(this.lines[this.row], this.col)
      } else if (this.row < this.lines.length - 1) {
        this.row += 1
        this.col = 0
      }
    } else if (dir === 'up' && this.row > 0) {
      this.row -= 1
      this.col = Math.min(this.col, this.lines[this.row].length)
    } else if (dir === 'down' && this.row < this.lines.length - 1) {
      this.row += 1
      this.col = Math.min(this.col, this.lines[this.row].length)
    }
  }

  /** The buffer as screen lines, optionally decorated (syntax highlighting),
   *  with the cursor cell drawn inverse over the decorated text. */
  renderLines(decorate: LineDecorator = identity): string[] {
    return this.lines.map((line, i) =>
      i === this.row ? this.cursorLine(decorate(line), line) : decorate(line)
    )
  }

  /** Invert the cursor cell on the (possibly colored) rendered line. Splices in
   *  visible-cell space so it survives the decorator's SGR codes. */
  private cursorLine(rendered: string, raw: string): string {
    const at = this.charAtCol(raw, this.col)
    // Map the buffer index to a visible column so wide glyphs before the cursor
    // don't shift the inverted cell off the character under it.
    const visualCol = cellWidth(raw.slice(0, this.col))
    const before = clipAnsi(rendered, visualCol)
    const after = sliceCellsFrom(rendered, visualCol + cellWidth(at))
    return `${before}${INVERSE}${at}${RESET}${after}`
  }
}
