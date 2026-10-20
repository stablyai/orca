// Character classes as RE2 holds them under Chromium's Latin-1 encoding, for size estimates
// and for spelling RE2-only class syntax ([:alpha:]) in JS.

export type Ranges = [number, number][]

/** "a-z09" style range lists, kept as strings to stay readable. */
export function rangesOf(spec: string): Ranges {
  const ranges: Ranges = []
  for (let i = 0; i < spec.length; i++) {
    const lo = spec.charCodeAt(i)
    const ranged = spec[i + 1] === '-' && i + 2 < spec.length
    ranges.push([lo, ranged ? spec.charCodeAt((i += 2)) : lo])
  }
  return ranges
}

// RE2's \d \s \w (no \v in \s) and POSIX classes.
const PERL_CLASSES: Record<string, string> = { d: '0-9', s: '\t\n\f\r ', w: '0-9A-Z_a-z' }
export const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\x00-\x7f',
  blank: '\t ',
  cntrl: '\x00-\x1f\x7f',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-/:-@[-`{-~',
  space: '\t-\r ',
  upper: 'A-Z',
  word: '0-9A-Z_a-z',
  xdigit: '0-9A-Fa-f'
}

export const hex = (code: number): string =>
  code > 0xff
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : `\\x${code.toString(16).padStart(2, '0')}`
export const rangesSource = (ranges: Ranges): string =>
  ranges.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join('')

/** A Latin-1 character set, which is how RE2 holds a class under Chromium's encoding. */
export class CharSet {
  private readonly members = new Uint8Array(256)

  add(ranges: Ranges, negated = false): this {
    for (let code = 0; code < 256; code++) {
      if (ranges.some(([lo, hi]) => lo <= code && code <= hi) !== negated) {
        this.members[code] = 1
      }
    }
    return this
  }

  negate(): this {
    this.members.forEach((member, code) => (this.members[code] = 1 - member))
    return this
  }

  ranges(): Ranges {
    const ranges: Ranges = []
    for (let code = 0; code < 256; code++) {
      if (this.members[code] && !this.members[code - 1]) {
        ranges.push([code, code])
      }
      const last = ranges.at(-1)
      if (this.members[code] && last) {
        last[1] = code
      }
    }
    return ranges
  }

  /** Compiled size: a byte range per run (A-Z runs free when both cases match) plus alts. */
  cost(fold: boolean): number {
    let foldsAscii = true
    for (let code = 0x41; code <= 0x5a; code++) {
      if (fold) {
        this.members[code] = this.members[code + 32] = this.members[code] | this.members[code + 32]
      }
      foldsAscii &&= this.members[code] === this.members[code + 32]
    }
    const kept = this.ranges().filter(([lo, hi]) => !(foldsAscii && lo >= 0x41 && hi <= 0x5a))
    return Math.max(1, 2 * kept.length - 1)
  }
}

export const perlClass = (letter: string): CharSet | null => {
  const spec = PERL_CLASSES[letter.toLowerCase()]
  return spec ? new CharSet().add(rangesOf(spec), letter !== letter.toLowerCase()) : null
}
