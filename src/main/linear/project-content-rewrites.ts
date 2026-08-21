/**
 * Linear rewrites `Project.content` Markdown as it stores it, so a write never
 * reads back byte-identical to what was sent. Observed against the live API:
 *
 * - a bare `https://x` becomes `[https://x](<https://x>)`
 * - a bare `www.x` becomes `[www.x](<http://www.x>)`
 * - every link destination is wrapped in angle brackets: `[t](/rel)` -> `[t](</rel>)`
 * - trailing whitespace is stripped
 *
 * These rewrites are stable: writing a stored value back is a no-op. This module
 * models them so no-op detection and read-back verification compare intent
 * rather than spelling.
 *
 * Clearing is the one case where it also changes what is sent. Linear silently
 * ignores a `content` write of `null` or `""` — the mutation reports success and
 * the old body survives — but stores whitespace-only content as `""`. So a clear
 * travels as a single space, and an emptied body reads back as `""` and never
 * returns to `null`.
 */

const ABSOLUTE_URL = /^https?:\/\//
const WHITESPACE = /\s/

/**
 * `next[i]` is the nearest index at or after `i` where `isStop` holds, or the
 * string length if there is none. One backward pass over the string, so every
 * transform below scans its input exactly once with O(1) work per character —
 * no regex backtracking, no rescanning from every unmatched delimiter, so
 * adversarial input (many `[`/`<` with no closing partner) costs the same as
 * well-formed input instead of the O(n^2) a backtracking-regex `.replace` gives.
 */
function nextStopIndex(value: string, isStop: (ch: string) => boolean): Int32Array {
  const n = value.length
  const next = new Int32Array(n + 1)
  next[n] = n
  for (let i = n - 1; i >= 0; i -= 1) {
    next[i] = isStop(value[i]) ? i : next[i + 1]
  }
  return next
}

/** `](<dest>)` -> `](dest)`. */
function unwrapAngleDestinations(value: string): string {
  const n = value.length
  const nextAngle = nextStopIndex(value, (ch) => ch === '>')
  let out = ''
  let i = 0
  while (i < n) {
    if (value[i] === ']' && value[i + 1] === '(' && value[i + 2] === '<') {
      const destStart = i + 3
      const close = nextAngle[destStart]
      if (close < n && value[close + 1] === ')') {
        out += `](${value.slice(destStart, close)})`
        i = close + 2
        continue
      }
    }
    out += value[i]
    i += 1
  }
  return out
}

/** `<https://x>` -> `https://x`. */
function unwrapAngleAutolinks(value: string): string {
  const n = value.length
  const nextTerminator = nextStopIndex(value, (ch) => ch === '>' || WHITESPACE.test(ch))
  let out = ''
  let i = 0
  while (i < n) {
    if (value[i] === '<') {
      const contentStart = i + 1
      const close = nextTerminator[contentStart]
      if (close < n && value[close] === '>' && close > contentStart) {
        const content = value.slice(contentStart, close)
        if (content.startsWith('http://') || content.startsWith('https://')) {
          out += content
          i = close + 1
          continue
        }
      }
    }
    out += value[i]
    i += 1
  }
  return out
}

/** `[label](dest)` -> `label`, only when the link is Linear's own autolink rewrite. */
function collapseAutolinkMarkdownLinks(value: string): string {
  const n = value.length
  const nextCloseBracket = nextStopIndex(value, (ch) => ch === ']')
  const nextDestTerminator = nextStopIndex(value, (ch) => ch === ')' || WHITESPACE.test(ch))
  let out = ''
  let i = 0
  while (i < n) {
    if (value[i] === '[') {
      const labelStart = i + 1
      const closeBracket = nextCloseBracket[labelStart]
      if (closeBracket < n && value[closeBracket + 1] === '(') {
        const destStart = closeBracket + 2
        const destEnd = nextDestTerminator[destStart]
        if (destEnd < n && value[destEnd] === ')') {
          const label = value.slice(labelStart, closeBracket)
          const destination = value.slice(destStart, destEnd)
          const linkEnd = destEnd + 1
          out += isAutolinkOf(label, destination) ? label : value.slice(i, linkEnd)
          i = linkEnd
          continue
        }
      }
    }
    out += value[i]
    i += 1
  }
  return out
}

/**
 * Collapses only the distinctions Linear itself collapses, so two values that
 * canonicalize alike are guaranteed to store alike.
 */
function canonicalizeLinearProjectContentUncached(value: string): string {
  return collapseAutolinkMarkdownLinks(
    unwrapAngleAutolinks(unwrapAngleDestinations(value))
  ).trimEnd()
}

// Why: one edit canonicalizes the same requested/previous/current strings up to
// 9 times (pre-write noop check, read-back verification, clear detection); a
// tiny cache collapses that back to one computation per distinct string.
const CANONICALIZE_CACHE_SIZE = 4
const canonicalizeCache: { input: string; output: string }[] = []

export function canonicalizeLinearProjectContent(value: string): string {
  const cached = canonicalizeCache.find((entry) => entry.input === value)
  if (cached) {
    return cached.output
  }
  const output = canonicalizeLinearProjectContentUncached(value)
  canonicalizeCache.unshift({ input: value, output })
  canonicalizeCache.length = Math.min(canonicalizeCache.length, CANONICALIZE_CACHE_SIZE)
  return output
}

/**
 * True when the link only restates its own label, which is what an autolink is.
 * Linear only autolinks a label that is itself an absolute http(s) URL (destination
 * repeats it verbatim) or a bare host/URL-less label (destination gains `http://`,
 * never `https://`) — never a relative path or unrelated label that merely happens
 * to equal the destination string.
 */
function isAutolinkOf(label: string, destination: string): boolean {
  if (!ABSOLUTE_URL.test(destination)) {
    return false
  }
  return ABSOLUTE_URL.test(label) ? destination === label : destination === `http://${label}`
}

/** A project with no overview: never set, explicitly cleared, or whitespace-only. */
export function isClearedLinearProjectContent(value: string | null): boolean {
  return value === null || canonicalizeLinearProjectContent(value) === ''
}

/** Compares content intent, not spelling; every empty form counts as the same clear. */
export function sameLinearProjectContent(left: string | null, right: string | null): boolean {
  if (isClearedLinearProjectContent(left) || isClearedLinearProjectContent(right)) {
    return isClearedLinearProjectContent(left) && isClearedLinearProjectContent(right)
  }
  return (
    canonicalizeLinearProjectContent(left as string) ===
    canonicalizeLinearProjectContent(right as string)
  )
}

/**
 * The value the mutation must carry. A clear becomes a single space because
 * Linear drops `null` and `""` on the floor without failing the write.
 */
export function linearProjectContentWriteValue(value: string | null): string {
  return isClearedLinearProjectContent(value) ? ' ' : (value as string)
}
