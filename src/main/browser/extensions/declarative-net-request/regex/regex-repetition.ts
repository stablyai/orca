import { MAX_PROGRAM_SIZE, piece, refuse, type Piece } from './regex-piece'

// RE2 repetition operators, spelled for V8's linear-time engine. That engine refuses a pattern
// whose nested repetitions replicate past 16, so counted ones are copied out as RE2 does.

const MAX_REPEAT = 1000
/** kMaxReplicationFactor in V8's experimental-compiler.cc. */
const MAX_REPLICATION = 16
// MaybeParseRepetition: {n}, {n,} or {n,m} without leading zeros; anything else is literal.
export const REPETITION = /^\{(0|[1-9]\d*)(,(0|[1-9]\d*)?)?\}/

/** max is -1 when unbounded; text is the operator as written, including a lazy '?'. */
export type Repetition = { min: number; max: number; text: string }

/** The repetition operator at the start of `rest`, if any. */
export function parseRepetition(rest: string): Repetition | null {
  const c = rest[0]
  let bounds: [number, number]
  let text: string
  if (c === '*' || c === '+' || c === '?') {
    bounds = c === '*' ? [0, -1] : c === '+' ? [1, -1] : [0, 1]
    text = c
  } else {
    const counted = c === '{' ? REPETITION.exec(rest) : null
    if (counted === null) {
      return null
    }
    const min = Number(counted[1])
    bounds = [
      min,
      counted[2] === undefined ? min : counted[3] === undefined ? -1 : Number(counted[3])
    ]
    if (min > MAX_REPEAT || bounds[1] > MAX_REPEAT || (bounds[1] !== -1 && bounds[1] < min)) {
      refuse()
    }
    text = counted[0]
  }
  return { min: bounds[0], max: bounds[1], text: rest[text.length] === '?' ? `${text}?` : text }
}

/** x{n,m} as n copies then m-n nested optional ones, as RE2 simplifies it. */
function copies(unit: string, min: number, max: number, lazy: boolean): string {
  if (max === -1) {
    return unit.repeat(min) + unit + (lazy ? '*?' : '*')
  }
  let optional = ''
  for (let i = min; i < max; i++) {
    optional = `(?:${unit}${optional})${lazy ? '??' : '?'}`
  }
  return unit.repeat(min) + optional
}

export function repeatedPiece(
  atom: Piece,
  { min, max, text }: Repetition,
  captures: boolean
): Piece {
  const count = max === -1 ? Math.max(min, 1) : max
  const cost =
    atom.cost * (atom.assertion ? Math.min(count, 1) : count) + (max === -1 ? 1 : max - min)
  // JS needs a group to quantify an assertion.
  const unit = atom.assertion ? `(?:${atom.src})` : atom.src
  const nullable = min === 0 || atom.nullable
  const literal = min > 0 ? (atom.char ?? atom.literal) : ''
  // Past the size limit the rule is refused anyway, so it is neither copied out nor checked.
  const overLimit = cost > MAX_PROGRAM_SIZE
  // Copies would renumber captures.
  if (text.startsWith('{') && !captures && !overLimit) {
    const src = atom.assertion
      ? // RE2 never repeats an assertion more than once.
        copies(unit, Math.min(min, 1), 1, false)
      : copies(unit, min, max, text.endsWith('?'))
    return { ...piece(src, cost), literal, nullable, replication: atom.replication }
  }
  // CanBeHandledVisitor::VisitQuantifier.
  const local = max !== -1 ? max : min > 0 && !atom.nullable ? min : min + 1
  const replication = Math.max(local, 1) * atom.replication
  if (replication > MAX_REPLICATION && !overLimit) {
    refuse()
  }
  return { ...piece(unit + text, cost), literal, nullable, replication }
}
