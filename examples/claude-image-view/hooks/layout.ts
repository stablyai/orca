// Adapted from Jarrod Watts’ claude-image-view (MIT); see ../LICENSE.
export type Size = { width: number; height: number }
export type Cells = { columns: number; rows: number }

const TILE_ROWS = 6
const MAX_COLUMNS = 32
const MIN_COLUMNS = 4
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// Used when the size is unknown (file over $.fs.read's 4 MiB cap, or no file).
const FALLBACK: Size = { width: 16, height: 10 }
// Each tile adds a border on every side and a label row under the picture.
const TILE_CHROME_ROWS = 3
const TILE_CHROME_COLUMNS = 2
const GAP = 1

/** The distinct image numbers a draft references, in the order they first appear. */
export function imageNumbers(draft: string): number[] {
  const seen = new Set<number>()
  for (const match of draft.matchAll(/\[Image #(\d+)\]/g)) {
    const n = Number(match[1])
    if (Number.isSafeInteger(n) && n > 0) {
      seen.add(n)
    }
  }
  return [...seen]
}

/** Width and height from a PNG's IHDR chunk, or null for invalid or incomplete bytes. */
export function pngSize(base64: string): Size | null {
  // 24 bytes cover the signature and IHDR's width and height; 32 base64 chars decode to exactly 24.
  const prefix = base64.slice(0, 32)
  if (!/^[A-Za-z0-9+/]{32}$/.test(prefix)) {
    return null
  }
  const head = Uint8Array.from(atob(prefix), (char) => char.charCodeAt(0))
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length < 24 || signature.some((byte, i) => head[i] !== byte)) {
    return null
  }
  if (head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82) {
    return null
  }
  // A complete PNG ends with an empty IEND chunk, even when its IHDR was written earlier.
  let end: string
  try {
    end = atob(base64.slice(-24)).slice(-12)
  } catch {
    return null
  }
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
  if (iend.some((byte, i) => end.charCodeAt(i) !== byte)) {
    return null
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** A picture box `rows` tall that keeps the picture's aspect ratio. */
export function fitCells(size: Size | null, tileRows = TILE_ROWS): Cells {
  const { width, height } = size ?? FALLBACK
  let rows = tileRows
  let columns = Math.round((rows * CELL_ASPECT * width) / height)
  if (columns > MAX_COLUMNS) {
    columns = MAX_COLUMNS
    rows = Math.max(1, Math.round((MAX_COLUMNS * height) / (CELL_ASPECT * width)))
  }
  return { columns: Math.max(MIN_COLUMNS, columns), rows: Math.min(rows, tileRows) }
}

/**
 * Picture boxes for one row of tiles that fits the band whole, so it never scrolls:
 * the tallest tiles whose chrome fits in `maxRows` and whose total width fits in `bodyColumns`.
 */
export function fitRow(
  sizes: readonly (Size | null)[],
  maxRows: number,
  bodyColumns: number
): Cells[] {
  if (maxRows < 4 || bodyColumns < 6) {
    return []
  }
  const tallest = Math.max(1, Math.min(TILE_ROWS, maxRows - TILE_CHROME_ROWS))
  for (let tileRows = tallest; tileRows > 1; tileRows--) {
    const cells = sizes.map((size) => fitCells(size, tileRows))
    const width =
      cells.reduce((sum, c) => sum + c.columns + TILE_CHROME_COLUMNS, 0) + GAP * (cells.length - 1)
    if (width <= bodyColumns) {
      return cells
    }
  }
  const cells: Cells[] = []
  let width = 0
  for (const size of sizes) {
    const cell = fitCells(size, 1)
    const nextWidth = width + cell.columns + TILE_CHROME_COLUMNS + (cells.length ? GAP : 0)
    if (nextWidth > bodyColumns) {
      break
    }
    cells.push(cell)
    width = nextWidth
  }
  return cells
}
