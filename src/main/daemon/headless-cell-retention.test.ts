import { afterEach, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

type RawCell = {
  content: number
  fg: number
  bg: number
  combinedData: string
  extended: unknown
}

type RawLine = {
  length: number
  _combined: Record<number, string>
  _extendedAttrs: Record<number, unknown>
  _cache: string
  _cacheValid: boolean
  getString(index: number): string
  getBg(index: number): number
  isCombined(index: number): number
  translateToString(trim?: boolean): string
  copyCellsFrom(
    source: RawLine,
    start: number,
    target: number,
    count: number,
    reverse: boolean
  ): void
  loadCell(index: number, cell: RawCell): RawCell
  set(index: number, value: [number, string, number, number]): void
  resize(cols: number, fill: RawCell): void
  fill(fill: RawCell, respectProtect?: boolean): void
  replaceCells(start: number, end: number, fill: RawCell, respectProtect?: boolean): void
}

type RawBuffer = {
  lines: { get(row: number): RawLine | undefined }
  getNullCell(): RawCell
}

const emulators: HeadlessEmulator[] = []
const HAS_EXTENDED = 0x10000000
const longCell = `a${'\u0301'.repeat(4096)}`

function create(alternate = false): HeadlessEmulator {
  const emulator = new HeadlessEmulator({ cols: 12, rows: 3, scrollback: 0 })
  emulators.push(emulator)
  if (alternate) {
    emulator.writeSync('\x1b[?1049h')
  }
  return emulator
}

function buffer(emulator: HeadlessEmulator): RawBuffer {
  const terminal = emulator['terminal']
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These tests exercise the pinned xterm core's internal BufferLine API.
  return (terminal as typeof terminal & { _core: { buffer: RawBuffer } })._core.buffer
}

function line(emulator: HeadlessEmulator, row = 0): RawLine {
  const value = buffer(emulator).lines.get(row)
  if (!value) {
    throw new Error(`Expected terminal row ${row}`)
  }
  return value
}

function blank(emulator: HeadlessEmulator): RawCell {
  return buffer(emulator).getNullCell()
}

function expectOnlyLiveEntries(value: RawLine): void {
  for (const key of Object.keys(value._combined)) {
    expect(value.isCombined(Number(key)), `combined cell ${key}`).not.toBe(0)
  }
  for (const key of Object.keys(value._extendedAttrs)) {
    expect(value.getBg(Number(key)) & HAS_EXTENDED, `extended cell ${key}`).not.toBe(0)
  }
}

afterEach(() => {
  for (const emulator of emulators.splice(0)) {
    emulator.dispose()
  }
})

it.each([false, true])('keeps live combining text intact, alternate: %s', (alternate) => {
  const emulator = create(alternate)
  emulator.writeSync(longCell)
  expect(line(emulator).getString(0)).toBe(longCell)
  expect(emulator.getSnapshot().snapshotAnsi).toContain(longCell)
})

it.each([false, true])(
  'releases overwritten text without another translation, alternate: %s',
  (alternate) => {
    const emulator = create(alternate)
    emulator.writeSync(longCell)
    const row = line(emulator)
    expect(row.translateToString(true)).toBe(longCell)
    emulator.writeSync('\rZ')
    expect(row._cacheValid).toBe(false)
    expect(row._cache).toBe('')
    expect(row._combined).toEqual({})
    expect(row.getString(0)).toBe('Z')
  }
)

it.each(['\r\x1b[2K', '\r\x1b[X', '\r\x1b[P'])(
  'releases erased combined and extended data: %s',
  (erase) => {
    const emulator = create()
    emulator.writeSync(`\x1b[4:3m${longCell}\x1b[0m`)
    const row = line(emulator)
    expect(Object.keys(row._extendedAttrs)).toHaveLength(1)
    row.translateToString(true)
    emulator.writeSync(erase)
    expect(row._combined).toEqual({})
    expect(row._extendedAttrs).toEqual({})
    expect(row._cache).toBe('')
  }
)

it('releases a wide combined cell when either half is overwritten', () => {
  const emulator = create()
  emulator.writeSync(`界${'\u0301'.repeat(512)}`)
  expect(line(emulator).getString(0)).toHaveLength(513)
  emulator.writeSync('\x1b[1;2HX')
  expect(line(emulator)._combined).toEqual({})
  expectOnlyLiveEntries(line(emulator))
  expect(line(emulator).translateToString(true)).toBe(' X')
})

it('moves live combined and extended data through insert and delete', () => {
  const emulator = create()
  emulator.writeSync('\x1b[4:3ma\u0301\x1b[0mB\x1b[1;1H\x1b[@')
  const row = line(emulator)
  expect(row.getString(1)).toBe('a\u0301')
  expectOnlyLiveEntries(row)
  emulator.writeSync('\x1b[P')
  expect(row.getString(0)).toBe('a\u0301')
  expect(row.getString(1)).toBe('B')
  expectOnlyLiveEntries(row)
})

it.each([
  {
    start: 0,
    target: 1,
    count: 3,
    reverse: true,
    expected: ['a\u0301', 'a\u0301', 'B', 'c\u0301']
  },
  { start: 1, target: 0, count: 3, reverse: false, expected: ['B', 'c\u0301', 'D', 'D'] },
  { start: 0, target: 0, count: 4, reverse: false, expected: ['a\u0301', 'B', 'c\u0301', 'D'] }
])(
  'preserves overlapping copies: $start to $target',
  ({ start, target, count, reverse, expected }) => {
    const emulator = create()
    emulator.writeSync('\x1b[4:3ma\u0301\x1b[0mBc\u0301D')
    const row = line(emulator)
    row.translateToString(true)
    row.copyCellsFrom(row, start, target, count, reverse)
    expect(row._cache).toBe('')
    expect(Array.from({ length: 4 }, (_, index) => row.getString(index))).toEqual(expected)
    expectOnlyLiveEntries(row)
  }
)

it.each(['fill', 'replace'] as const)('preserves protected live cells during %s', (operation) => {
  const emulator = create()
  emulator.writeSync('\x1b[1"q\x1b[4:3ma\u0301\x1b[0"q\x1b[0mb\u0301')
  const row = line(emulator)
  if (operation === 'fill') {
    row.fill(blank(emulator), true)
  } else {
    row.replaceCells(0, row.length, blank(emulator), true)
  }
  expect(row.getString(0)).toBe('a\u0301')
  expect(row.getString(1)).toBe('')
  expectOnlyLiveEntries(row)
})

it('releases truncated cells and cache on shrink, without reviving them on grow', () => {
  const emulator = create()
  emulator.writeSync(`a\u0301B${longCell}`)
  const row = line(emulator)
  row.translateToString(true)
  row.resize(2, blank(emulator))
  expect(row._cache).toBe('')
  expect(row._combined).toEqual({ 0: 'a\u0301' })
  row.resize(12, blank(emulator))
  expect(row.getString(2)).toBe('')
  expectOnlyLiveEntries(row)
})

it('legacy scalar writes release combined text while retaining unchanged background attributes', () => {
  const emulator = create()
  emulator.writeSync('\x1b[4:3ma\u0301')
  const row = line(emulator)
  row.set(0, [0, 'Z', 1, 90])
  expect(row._combined).toEqual({})
  expect(Object.keys(row._extendedAttrs)).toEqual(['0'])
  expectOnlyLiveEntries(row)
})

it('preserves normal-buffer combining text while clearing the alternate buffer', () => {
  const emulator = create()
  emulator.writeSync(`N\u0301\x1b[?1049h${longCell}\rZ\x1b[2K`)
  expect(line(emulator)._combined).toEqual({})
  emulator.writeSync('\x1b[?1049l')
  expect(line(emulator).getString(0)).toBe('N\u0301')
})
