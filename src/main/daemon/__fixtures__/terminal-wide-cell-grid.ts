/**
 * A cell-level model of a terminal grid in which one glyph can occupy two cells,
 * plus readers for the same view out of a real xterm buffer.
 *
 * Why a model rather than hand-written expectations (#15192): the cases that
 * matter are repaints whose cursor lands on a wide glyph's TRAILING cell, and
 * the correct outcome there — blank the orphaned leading half — is too fiddly to
 * spell out for every width and column by hand.
 *
 * What agreement does and does not prove: the model shares no code with xterm - its
 * own width oracle, cursor and erase semantics - so agreement is not a code-reuse
 * tautology. But its rules were chosen to match observed behaviour, so it is a
 * regression detector that locks in today's semantics, not a first-principles oracle.
 * If both were wrong in the same way it would not notice.
 */
import type { Terminal } from '@xterm/headless'

/** Code points that occupy two console cells: Hangul, CJK ideographs, kana, fullwidth forms. */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿︰-﹏！-｠￠-￦]/

export function isWideGlyph(ch: string): boolean {
  return WIDE.test(ch)
}

/** `null` marks a wide glyph's trailing cell, which renders as nothing. */
type Cell = string | null

export class WideCellGrid {
  private readonly rows: Cell[][] = []
  private row = 0
  private col = 0

  constructor(private readonly cols: number) {}

  private at(row: number): Cell[] {
    while (this.rows.length <= row) {
      this.rows.push(Array.from<Cell>({ length: this.cols }).fill(' '))
    }
    return this.rows[row]!
  }

  /** Clears whichever half-pair covers `col`, so no orphaned half is ever left behind. */
  private clearPair(row: number, col: number): void {
    if (col < 0 || col >= this.cols) {
      return
    }
    const cells = this.at(row)
    if (cells[col] === null) {
      cells[col] = ' '
      if (col > 0) {
        cells[col - 1] = ' '
      }
      return
    }
    if (col + 1 < this.cols && cells[col + 1] === null) {
      cells[col] = ' '
      cells[col + 1] = ' '
    }
  }

  moveTo(row: number, col: number): void {
    this.row = row
    this.col = col
  }

  carriageReturn(): void {
    this.col = 0
  }

  lineFeed(): void {
    this.row += 1
  }

  eraseToLineEnd(): void {
    this.clearPair(this.row, this.col)
    const cells = this.at(this.row)
    for (let col = this.col; col < this.cols; col += 1) {
      cells[col] = ' '
    }
  }

  eraseLine(): void {
    this.rows[this.row] = Array.from<Cell>({ length: this.cols }).fill(' ')
  }

  text(value: string): void {
    for (const ch of value) {
      if (ch === '\r') {
        this.carriageReturn()
        continue
      }
      if (ch === '\n') {
        this.lineFeed()
        continue
      }
      const width = isWideGlyph(ch) ? 2 : 1
      // A wide glyph that does not fit blanks the rest of the row and wraps whole.
      if (this.col + width > this.cols) {
        const cells = this.at(this.row)
        for (let col = this.col; col < this.cols; col += 1) {
          this.clearPair(this.row, col)
          cells[col] = ' '
        }
        this.row += 1
        this.col = 0
      }
      this.clearPair(this.row, this.col)
      if (width === 2) {
        this.clearPair(this.row, this.col + 1)
      }
      const cells = this.at(this.row)
      cells[this.col] = ch
      if (width === 2) {
        cells[this.col + 1] = null
      }
      this.col += width
    }
  }

  render(rowCount: number): string[] {
    const out: string[] = []
    for (let row = 0; row < rowCount; row += 1) {
      const cells = this.rows[row]
      out.push(
        cells
          ? cells
              .map((cell) => cell ?? '')
              .join('')
              .replace(/\s+$/, '')
          : ''
      )
    }
    return out
  }
}

/** Physical rows, right-trimmed. A wide glyph's trailing cell contributes nothing, as in the model. */
export function readGridRows(terminal: Terminal, rowCount = terminal.rows): string[] {
  const buffer = terminal.buffer.active
  const out: string[] = []
  for (let row = 0; row < rowCount; row += 1) {
    out.push((buffer.getLine(row)?.translateToString(false) ?? '').replace(/\s+$/, ''))
  }
  return out
}

/**
 * Rows joined across xterm's wrap continuations, with whitespace removed.
 *
 * Why whitespace-free: when a wide glyph cannot fit, xterm blanks the last cell
 * and wraps the glyph whole. That blank is indistinguishable in the buffer from
 * a space the program wrote, so a joined line gains one space per seam at some
 * widths and not others. Dropping spaces removes an ambiguity the buffer really
 * does not carry, and keeps what this is for: a doubled or missing glyph still
 * shows. (Same normalization as headless-emulator-wide-char-snapshot.test.ts.)
 */
export function readWrappedLineGlyphs(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const text = line.translateToString(false)
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }
  return lines.map((line) => line.replace(/\s+/g, ''))
}
