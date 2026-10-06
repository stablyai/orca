// Seeded VT stream generator for the serialize round-trip differential fuzz
// (serialize-grid.differential.fuzz.test.ts). Unlike agent-tui-ansi-fuzz-stream
// it deliberately covers everything SerializeAddon must carry, including the
// ops that leave xterm lines longer than the grid: column shrinks in the
// alternate buffer and in a non-reflowing (pre-21376 ConPTY) normal buffer.
import { mulberry32 } from '../../shared/agent-tui-ansi-fuzz-stream'

export type SerializeFuzzCategory = 'normal' | 'alt' | 'conpty'

export type SerializeFuzzStep =
  | { kind: 'write'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'check'; scrollback: number | undefined }

export type SerializeFuzzCase = {
  seed: number
  category: SerializeFuzzCategory
  cols: number
  rows: number
  sourceScrollback: number
  steps: SerializeFuzzStep[]
}

type Rng = () => number

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

const WIDE = ['中', '文字', '한글', '日本語', '😀', '🟢', '👍🏽', '👨‍👩‍👧', '🇰🇷', '✅'] as const
const COMBINING = ['é', 'ạ̈', 'ñ', '́', 'o̶'] as const
const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-_/|#'

function asciiRun(rng: Rng, maxLen: number): string {
  let out = ''
  for (let i = int(rng, 1, maxLen); i > 0; i--) {
    out += ASCII[int(rng, 0, ASCII.length - 1)]
  }
  return out
}

function textRun(rng: Rng, cols: number): string {
  const parts: string[] = []
  for (let i = int(rng, 1, 4); i > 0; i--) {
    const roll = rng()
    parts.push(
      roll < 0.55
        ? asciiRun(rng, Math.max(2, cols))
        : roll < 0.85
          ? pick(rng, WIDE).repeat(int(rng, 1, 4))
          : pick(rng, COMBINING)
    )
  }
  return parts.join('')
}

function color(rng: Rng, base: 30 | 40): string {
  const roll = rng()
  if (roll < 0.35) {
    return String(base + int(rng, 0, 7) + (rng() < 0.4 ? 60 : 0))
  }
  if (roll < 0.65) {
    return `${base + 8};5;${int(rng, 0, 255)}`
  }
  if (roll < 0.9) {
    return `${base + 8};2;${int(rng, 0, 255)};${int(rng, 0, 255)};${int(rng, 0, 255)}`
  }
  return String(base + 9)
}

const SGR_FLAGS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '4:2',
  '4:3',
  '4:5',
  '5',
  '7',
  '8',
  '9',
  '21',
  '22',
  '23',
  '24',
  '25',
  '27',
  '28',
  '29',
  '53',
  '55'
] as const

function sgr(rng: Rng): string {
  const parts: string[] = []
  for (let i = int(rng, 1, 3); i > 0; i--) {
    const roll = rng()
    parts.push(
      roll < 0.45
        ? pick(rng, SGR_FLAGS)
        : roll < 0.75
          ? color(rng, 30)
          : roll < 0.95
            ? color(rng, 40)
            : `58;5;${int(rng, 0, 255)}`
    )
  }
  return `\x1b[${parts.join(';')}m`
}

function cursorOp(rng: Rng, cols: number, rows: number): string {
  // Coordinates sometimes exceed the grid on purpose: xterm clamps them.
  const r = int(rng, 1, rows + 2)
  const c = int(rng, 1, cols + 3)
  return pick(rng, [
    `\x1b[${r};${c}H`,
    `\x1b[${r};${c}f`,
    `\x1b[${int(rng, 1, 5)}A`,
    `\x1b[${int(rng, 1, 5)}B`,
    `\x1b[${int(rng, 1, 8)}C`,
    `\x1b[${int(rng, 1, 8)}D`,
    `\x1b[${c}G`,
    `\x1b[${r}d`,
    '\r',
    '\b',
    '\t',
    '\x1b[2I',
    '\x1b[Z'
  ])
}

function editOp(rng: Rng): string {
  const n = int(rng, 1, 6)
  return pick(rng, [
    '\x1b[J',
    '\x1b[1J',
    '\x1b[2J',
    '\x1b[3J',
    '\x1b[K',
    '\x1b[1K',
    '\x1b[2K',
    `\x1b[${n}X`,
    `\x1b[${n}@`,
    `\x1b[${n}P`,
    `\x1b[${n}L`,
    `\x1b[${n}M`,
    `\x1b[${n}S`,
    `\x1b[${n}T`,
    '\x1bM',
    '\x1bD',
    '\x1bE'
  ])
}

function scrollRegionOp(rng: Rng, rows: number): string {
  if (rng() < 0.35) {
    return '\x1b[r'
  }
  const top = int(rng, 1, Math.max(1, rows - 1))
  return `\x1b[${top};${int(rng, top + 1, rows + 1)}r`
}

const MODE_TOGGLES = [
  '\x1b[?7l',
  '\x1b[?7h',
  '\x1b[4h',
  '\x1b[4l',
  '\x1b[?6h',
  '\x1b[?6l',
  '\x1b[?1h',
  '\x1b[?1l',
  '\x1b[?2004h',
  '\x1b[?2004l',
  '\x1b[?25l',
  '\x1b[?25h',
  '\x1b[?1000h',
  '\x1b[?1003h',
  '\x1b[?1000l',
  '\x1b[?45h',
  '\x1b[?45l',
  '\x1b=',
  '\x1b>',
  '\x1b[?1004h'
] as const

const SCREEN_TOGGLES = [
  '\x1b[?1049h',
  '\x1b[?1049l',
  '\x1b[?47h',
  '\x1b[?47l',
  '\x1b[?1047h',
  '\x1b[?1047l',
  '\x1b7',
  '\x1b8',
  '\x1b[s',
  '\x1b[u'
] as const

type Dims = { cols: number; rows: number }

function resizeStep(rng: Rng, dims: Dims): SerializeFuzzStep {
  const roll = rng()
  // Shrink-heavy: a column shrink is what leaves lines wider than the grid.
  const cols =
    roll < 0.55
      ? int(rng, Math.max(2, dims.cols - 30), Math.max(2, dims.cols - 1))
      : roll < 0.9
        ? int(rng, dims.cols + 1, Math.min(140, dims.cols + 30))
        : dims.cols
  const rows = rng() < 0.4 ? int(rng, 2, 16) : dims.rows
  dims.cols = cols
  dims.rows = rows
  return { kind: 'resize', cols, rows }
}

function checkStep(rng: Rng): SerializeFuzzStep {
  return { kind: 'check', scrollback: pick(rng, [undefined, 0, int(rng, 1, 30), 5000]) }
}

function nextStep(rng: Rng, dims: Dims, category: SerializeFuzzCategory): SerializeFuzzStep {
  const roll = rng()
  const write = (data: string): SerializeFuzzStep => ({ kind: 'write', data })
  if (roll < 0.3) {
    return write(textRun(rng, dims.cols))
  }
  if (roll < 0.42) {
    return write(sgr(rng))
  }
  if (roll < 0.54) {
    return write(cursorOp(rng, dims.cols, dims.rows))
  }
  if (roll < 0.64) {
    return write(editOp(rng))
  }
  if (roll < 0.71) {
    return write(pick(rng, ['\r\n', '\n', '\r\n\r\n', '\x1b[0m\r\n']))
  }
  if (roll < 0.75) {
    return write(scrollRegionOp(rng, dims.rows))
  }
  if (roll < 0.8) {
    return write(pick(rng, MODE_TOGGLES))
  }
  if (roll < (category === 'normal' ? 0.83 : 0.82)) {
    return write(pick(rng, SCREEN_TOGGLES))
  }
  if (roll < 0.95) {
    return resizeStep(rng, dims)
  }
  return checkStep(rng)
}

const START_DIMS: readonly Dims[] = [
  { cols: 10, rows: 4 },
  { cols: 20, rows: 6 },
  { cols: 40, rows: 8 },
  { cols: 80, rows: 12 }
]

export function buildSerializeFuzzCase(
  seed: number,
  category: SerializeFuzzCategory
): SerializeFuzzCase {
  const rng = mulberry32(seed)
  const start = pick(rng, START_DIMS)
  const dims = { ...start }
  const steps: SerializeFuzzStep[] = []
  if (category === 'alt') {
    steps.push({ kind: 'write', data: pick(rng, ['\x1b[?1049h', '\x1b[?47h', '\x1b[?1047h']) })
  }
  for (let i = int(rng, 8, 60); i > 0; i--) {
    steps.push(nextStep(rng, dims, category))
  }
  steps.push(checkStep(rng))
  return {
    seed,
    category,
    cols: start.cols,
    rows: start.rows,
    sourceScrollback: pick(rng, [0, 10, 200]),
    steps
  }
}
