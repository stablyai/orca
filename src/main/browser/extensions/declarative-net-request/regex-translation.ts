import { CharSet, hex, perlClass, POSIX_CLASSES, rangesOf, rangesSource } from './regex-char-set'

// RE2 syntax (as Chromium configures it: Latin-1, Perl flags) translated to JS RegExp source.
// Refuses what RE2 refuses and what JS reads differently or cannot express (\p classes, (?U)).
// Alongside the source it estimates RE2's program size and finds a literal every match contains.

type Piece = {
  src: string
  /** Approximate RE2 instruction count. */
  cost: number
  /** Set when the piece is one literal character (lower-cased). */
  char: string | null
  /** Longest literal every match contains (lower-cased). */
  literal: string
  assertion: boolean
}

class Refusal extends Error {}

const refuse = (): never => {
  throw new Refusal()
}

const MAX_REPEAT = 1000
// MaybeParseRepetition: {n}, {n,} or {n,m} without leading zeros; anything else is literal.
const REPETITION = /^\{(0|[1-9]\d*)(,(0|[1-9]\d*)?)?\}/
const C_ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, a: 7 }

const piece = (src: string, cost: number, assertion = false): Piece => ({
  src,
  cost,
  char: null,
  literal: '',
  assertion
})

const literal = (code: number): Piece => ({
  ...piece(hex(code), 1),
  char: String.fromCharCode(code).toLowerCase()
})

/** JS modifier text for RE2 flags; (?U) has no JS equivalent. */
function modifiers(on: string, off: string | undefined): string {
  const text = off ? `${on}-${off}` : on
  return text.includes('U') ? refuse() : text
}

const longer = (a: string, b: string): string => (b.length > a.length ? b : a)
const isOctal = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '7'

class Re2ToJs {
  private pos = 0
  captureCount = 0

  constructor(
    private pattern: string,
    private readonly capturing: boolean,
    private readonly fold: boolean
  ) {}

  done(): boolean {
    return this.pos >= this.pattern.length
  }

  private peek(offset = 0): string | undefined {
    return this.pattern[this.pos + offset]
  }

  private rest(): string {
    return this.pattern.slice(this.pos)
  }

  /** Alternatives up to ')' or the end; "(?i)" inside persists into later alternatives. */
  alternation(): Piece {
    const persisting: string[] = []
    const alternatives = [this.sequence(persisting)]
    while (this.peek() === '|') {
      this.pos++
      const next = this.sequence(persisting)
      alternatives.push({
        ...next,
        src: persisting.reduceRight((src, f) => `(?${f}:${src})`, next.src)
      })
    }
    const cost = alternatives.reduce(
      (total, alternative) => total + alternative.cost,
      alternatives.length - 1
    )
    return {
      ...piece(alternatives.map((alternative) => alternative.src).join('|'), cost),
      literal: alternatives.length === 1 ? alternatives[0].literal : ''
    }
  }

  private sequence(persisting: string[]): Piece {
    const result = piece('', 0)
    let run = ''
    while (this.pos < this.pattern.length && this.peek() !== '|' && this.peek() !== ')') {
      const flags = /^\(\?([imsU]*)(?:-([imsU]+))?\)/.exec(this.rest())
      if (flags !== null) {
        // RE2 applies the flags to the rest of the group, including later alternatives.
        this.pos += flags[0].length
        persisting.push(modifiers(flags[1], flags[2]))
        const tail = this.sequence(persisting)
        result.src += `(?${persisting.at(-1)}:${tail.src})`
        result.cost += tail.cost
        result.literal = longer(longer(result.literal, run), tail.literal)
        return result
      }
      const atom = this.quantified()
      result.src += atom.src
      result.cost += atom.cost
      if (atom.char !== null) {
        run += atom.char
      } else if (!atom.assertion) {
        result.literal = longer(longer(result.literal, run), atom.literal)
        run = ''
      }
    }
    result.literal = longer(result.literal, run)
    return result
  }

  private quantified(): Piece {
    const atom = this.atom()
    const quantifier = this.quantifier()
    if (quantifier === null) {
      return atom
    }
    if (this.quantifier() !== null) {
      refuse() // "a**", "a{2}*": stacked repetition
    }
    const { min, max, text } = quantifier
    const count = max === -1 ? Math.max(min, 1) : max
    // RE2 never repeats an assertion more than once; JS needs a group to quantify one.
    return {
      ...piece(atom.assertion ? `(?:${atom.src})${text}` : atom.src + text, 0),
      cost:
        atom.cost * (atom.assertion ? Math.min(count, 1) : count) + (max === -1 ? 1 : max - min),
      literal: min > 0 ? (atom.char ?? atom.literal) : ''
    }
  }

  private quantifier(): { min: number; max: number; text: string } | null {
    const c = this.peek()
    let bounds: [number, number]
    let text: string
    if (c === '*' || c === '+' || c === '?') {
      bounds = c === '*' ? [0, -1] : c === '+' ? [1, -1] : [0, 1]
      text = c
    } else {
      const counted = c === '{' ? REPETITION.exec(this.rest()) : null
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
    this.pos += text.length
    if (this.peek() === '?') {
      this.pos++
      text += '?'
    }
    return { min: bounds[0], max: bounds[1], text }
  }

  private atom(): Piece {
    const c = this.pattern[this.pos++]
    switch (c) {
      case '(':
        return this.group()
      case '[':
        return this.bracketClass()
      case '\\':
        return this.escape()
      case '.':
        return piece('.', new CharSet().add([[10, 10]], true).cost(this.fold))
      case '^':
      case '$':
        return piece(c, 1, true)
      case '*':
      case '+':
      case '?':
        return refuse() // nothing to repeat
      default:
        // A '{' that does not start a repetition is a literal in RE2.
        return c === '{' && REPETITION.test(this.pattern.slice(this.pos - 1))
          ? refuse()
          : literal(c.charCodeAt(0))
    }
  }

  private group(): Piece {
    let open = '('
    const named = /^\?P?<\w+>/.exec(this.rest())
    const flags = /^\?([imsU]*)(?:-([imsU]+))?:/.exec(this.rest())
    if (named !== null) {
      this.pos += named[0].length
    } else if (flags !== null) {
      this.pos += flags[0].length
      open = `(?${modifiers(flags[1], flags[2])}:`
    } else if (this.peek() === '?') {
      refuse() // lookaround, comments, bad flags
    }
    const capture = open === '('
    this.captureCount += capture ? 1 : 0
    const inner = this.alternation()
    if (this.pattern[this.pos++] !== ')') {
      refuse()
    }
    return {
      ...inner,
      src: `${open}${inner.src})`,
      cost: inner.cost + (capture && this.capturing ? 2 : 0)
    }
  }

  private escape(): Piece {
    const c = this.pattern[this.pos++] ?? refuse()
    if (c === 'b' || c === 'B') {
      return piece(`\\${c}`, 1, true)
    }
    if (c === 'A' || c === 'z') {
      return piece(c === 'A' ? '^' : '$', 1, true)
    }
    if (c === 'C') {
      return piece('[\\s\\S]', 1)
    }
    if (c === 'Q') {
      // \Q...\E: splice the quoted text back in as escaped literals and keep parsing.
      const end = this.pattern.indexOf('\\E', this.pos)
      const quoted = this.pattern.slice(this.pos, end === -1 ? undefined : end)
      const quotedSource = [...quoted].map((char) => hex(char.charCodeAt(0))).join('')
      this.pattern =
        this.pattern.slice(0, this.pos) +
        quotedSource +
        (end === -1 ? '' : this.pattern.slice(end + 2))
      return quoted === '' ? piece('', 0, true) : this.atom()
    }
    const perl = perlClass(c)
    return perl === null ? literal(this.escapedChar(c)) : piece(`\\${c}`, perl.cost(this.fold))
  }

  /** ParseEscape for one character; `c` was just consumed. */
  private escapedChar(c: string): number {
    if (!/[0-9A-Za-z]/.test(c) && c.charCodeAt(0) < 0x80) {
      return c.charCodeAt(0)
    }
    if (isOctal(c) && (c === '0' || isOctal(this.peek()))) {
      let code = Number(c)
      for (let i = 0; i < 2 && isOctal(this.peek()); i++) {
        code = code * 8 + Number(this.pattern[this.pos++])
      }
      return code <= 0xff ? code : refuse()
    }
    const hexEscape =
      c === 'x' ? /^(?:\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{2}))/.exec(this.rest()) : null
    if (hexEscape !== null) {
      this.pos += hexEscape[0].length
      const code = Number.parseInt(hexEscape[1] ?? hexEscape[2], 16)
      return code <= 0xff ? code : refuse()
    }
    // Backreferences, \e, \Z, \cX, \uXXXX, \p classes and other letters are errors in RE2.
    return C_ESCAPES[c] ?? refuse()
  }

  /** "[...]": JS reads "[]a]" and "[[:alpha:]]" differently, so the class is rebuilt. */
  private bracketClass(): Piece {
    const set = new CharSet()
    let src = ''
    const negated = this.peek() === '^'
    this.pos += negated ? 1 : 0
    for (let first = true; this.peek() !== ']' || first; first = false) {
      // ParseCCName: "[:" up to the first ":]" must name a known class.
      const posix = /^\[:(\^?)(.*?):\]/.exec(this.rest())
      const perl = this.peek() === '\\' ? perlClass(this.peek(1) ?? '') : null
      if (posix !== null) {
        const ranges = new CharSet()
          .add(rangesOf(POSIX_CLASSES[posix[2]] ?? refuse()), posix[1] === '^')
          .ranges()
        set.add(ranges)
        src += rangesSource(ranges)
        this.pos += posix[0].length
      } else if (perl !== null) {
        set.add(perl.ranges())
        src += this.pattern.slice(this.pos, (this.pos += 2))
      } else {
        const lo = this.classChar()
        const ranged = this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined
        const hi = ranged ? (this.pos++, this.classChar()) : lo
        set.add([[lo, hi < lo ? refuse() : hi]])
        src += rangesSource([[lo, hi]])
      }
    }
    this.pos++
    return piece(`[${negated ? '^' : ''}${src}]`, (negated ? set.negate() : set).cost(this.fold))
  }

  private classChar(): number {
    const c = this.pattern[this.pos++] ?? refuse()
    return c === '\\' ? this.escapedChar(this.pattern[this.pos++] ?? refuse()) : c.charCodeAt(0)
  }
}

export type Re2Translation = {
  source: string
  cost: number
  requiredLiteral: string
  captureCount: number
}

/** Null when RE2 would reject the syntax or JS cannot express it the same way. */
export function translateRe2(
  pattern: string,
  capturing: boolean,
  fold: boolean
): Re2Translation | null {
  const translator = new Re2ToJs(pattern, capturing, fold)
  try {
    const result = translator.alternation()
    // Anything left over is an unmatched ')'.
    if (!translator.done()) {
      return null
    }
    return {
      source: result.src,
      cost: result.cost,
      requiredLiteral: result.literal,
      captureCount: translator.captureCount
    }
  } catch (error) {
    if (error instanceof Refusal) {
      return null
    }
    throw error
  }
}
