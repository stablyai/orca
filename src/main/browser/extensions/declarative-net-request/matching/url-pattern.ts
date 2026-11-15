// urlFilter parsing and matching, ported from Chromium's indexed_rule.cc UrlFilterParser and
// components/url_pattern_index/{url_pattern.cc,fuzzy_pattern_matching.cc}.

export type DnrAnchor = 'none' | 'boundary' | 'subdomain'

export type DnrUrlFilter = {
  /** Pattern without anchors; lower-cased when the rule is case-insensitive. */
  pattern: string
  anchorLeft: DnrAnchor
  anchorRight: DnrAnchor
  matchCase: boolean
}

/** The request URL as url_pattern_index sees it: the canonical spec plus its host span. */
export type DnrUrlText = {
  spec: string
  lowerSpec: string
  hostBegin: number
  hostEnd: number
}

const SEPARATOR_PLACEHOLDER = 94 // '^'

/** UrlFilterParser: `|` and `||` on the left, `|` on the right; any other `|` is literal. */
export function parseUrlFilter(urlFilter: string): Omit<DnrUrlFilter, 'matchCase'> {
  const length = urlFilter.length
  let index = 0
  let anchorLeft: DnrAnchor = 'none'
  if (urlFilter[index] === '|') {
    index++
    anchorLeft = 'boundary'
    if (urlFilter[index] === '|') {
      index++
      anchorLeft = 'subdomain'
    }
  }
  const isAtRightAnchor = (at: number): boolean =>
    urlFilter[at] === '|' && at > 0 && at + 1 === length
  const start = index
  while (index < length && !isAtRightAnchor(index)) {
    index++
  }
  const pattern = urlFilter.slice(start, index)
  return { pattern, anchorLeft, anchorRight: isAtRightAnchor(index) ? 'boundary' : 'none' }
}

/** fuzzy_pattern_matching.h IsSeparator. Non-ASCII code units are never separators. */
function isSeparator(code: number): boolean {
  if (code === 95 || code === 45 || code === 46 || code === 37) {
    return false
  }
  if (code === SEPARATOR_PLACEHOLDER) {
    return true
  }
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
    return false
  }
  return code < 128
}

type Subpattern = {
  text: string
  fuzzy: boolean
  /** Longest run without '^' and its offset: lets fuzzy searches jump with indexOf. */
  anchor: string
  anchorOffset: number
}

function subpattern(text: string): Subpattern {
  let anchor = ''
  let anchorOffset = 0
  let offset = 0
  for (const piece of text.split('^')) {
    if (piece.length > anchor.length) {
      anchor = piece
      anchorOffset = offset
    }
    offset += piece.length + 1
  }
  return { text, fuzzy: text.includes('^'), anchor, anchorOffset }
}

function startsWithAt(text: string, position: number, sub: Subpattern): boolean {
  if (position < 0 || position + sub.text.length > text.length) {
    return false
  }
  if (!sub.fuzzy) {
    return text.startsWith(sub.text, position)
  }
  for (let i = 0; i < sub.text.length; i++) {
    const want = sub.text.charCodeAt(i)
    const have = text.charCodeAt(position + i)
    if (have !== want && (want !== SEPARATOR_PLACEHOLDER || !isSeparator(have))) {
      return false
    }
  }
  return true
}

/** Leftmost occurrence starting at or after `from` that ends at or before `limit`. */
function find(text: string, sub: Subpattern, from: number, limit = text.length): number {
  const last = limit - sub.text.length
  if (from > last) {
    return -1
  }
  if (!sub.fuzzy) {
    const found = text.indexOf(sub.text, from)
    return found !== -1 && found <= last ? found : -1
  }
  if (sub.anchor.length === 0) {
    for (let position = from; position <= last; position++) {
      if (startsWithAt(text, position, sub)) {
        return position
      }
    }
    return -1
  }
  // Candidates are wherever the literal part occurs; the separators are then checked in place.
  for (
    let hit = text.indexOf(sub.anchor, from + sub.anchorOffset);
    hit !== -1;
    hit = text.indexOf(sub.anchor, hit + 1)
  ) {
    const position = hit - sub.anchorOffset
    if (position > last) {
      return -1
    }
    if (startsWithAt(text, position, sub)) {
      return position
    }
  }
  return -1
}

function isSubdomainAnchored(url: DnrUrlText, text: string, position: number): boolean {
  return (
    position === url.hostBegin ||
    (position > url.hostBegin && position <= url.hostEnd && text.charCodeAt(position - 1) === 46)
  )
}

/** FindSubdomainAnchoredSubpattern: an occurrence starting at a (sub-)domain of the host. */
function findSubdomainAnchored(url: DnrUrlText, text: string, sub: Subpattern): number {
  const limit = Math.min(text.length, url.hostEnd + sub.text.length)
  for (let position = url.hostBegin; position <= url.hostEnd; position++) {
    position = find(text, sub, position, limit)
    if (position === -1 || isSubdomainAnchored(url, text, position)) {
      return position
    }
    position = text.indexOf('.', position)
    if (position === -1 || position >= url.hostEnd) {
      break
    }
  }
  return -1
}

function matchesLastInternal(
  left: DnrAnchor,
  right: DnrAnchor,
  url: DnrUrlText,
  text: string,
  start: number,
  sub: Subpattern
): boolean {
  const remaining = text.length - start
  if (left === 'none') {
    if (right === 'none') {
      return find(text, sub, start) !== -1
    }
    return sub.text.length <= remaining && startsWithAt(text, text.length - sub.text.length, sub)
  }
  if (left === 'boundary') {
    return right === 'none'
      ? startsWithAt(text, start, sub)
      : remaining === sub.text.length && startsWithAt(text, start, sub)
  }
  const hostNonEmpty = url.hostEnd > url.hostBegin
  if (right === 'none') {
    return hostNonEmpty && findSubdomainAnchored(url, text, sub) !== -1
  }
  const position = text.length - sub.text.length
  return (
    hostNonEmpty &&
    position >= 0 &&
    isSubdomainAnchored(url, text, position) &&
    startsWithAt(text, position, sub)
  )
}

type LastSubpattern = Subpattern & { withoutTrailingSeparator: Subpattern | null }

function lastSubpattern(text: string): LastSubpattern {
  return {
    ...subpattern(text),
    withoutTrailingSeparator: text.endsWith('^') ? subpattern(text.slice(0, -1)) : null
  }
}

/** DoesTextMatchLastSubpattern: a trailing `^` may also match the end of the URL. */
function matchesLast(
  left: DnrAnchor,
  right: DnrAnchor,
  url: DnrUrlText,
  text: string,
  start: number,
  sub: LastSubpattern
): boolean {
  if (matchesLastInternal(left, right, url, text, start, sub)) {
    return true
  }
  const trimmed = sub.withoutTrailingSeparator
  return trimmed !== null && matchesLastInternal(left, 'boundary', url, text, start, trimmed)
}

export class DnrUrlPatternMatcher {
  private readonly subpatterns: Subpattern[]
  private readonly last: LastSubpattern | null
  private readonly left: DnrAnchor
  private readonly right: DnrAnchor

  constructor(readonly filter: DnrUrlFilter) {
    const { pattern } = filter
    // MatchesUrl: "|*xyz" behaves as "*xyz" and "xyz*|" as "xyz*".
    this.left = pattern.startsWith('*') ? 'none' : filter.anchorLeft
    this.right = pattern.endsWith('*') ? 'none' : filter.anchorRight
    const pieces = pattern.split('*').filter((piece) => piece.length > 0)
    const lastPiece = pieces.pop()
    this.subpatterns = pieces.map(subpattern)
    this.last = lastPiece === undefined ? null : lastSubpattern(lastPiece)
  }

  matches(url: DnrUrlText): boolean {
    const text = this.filter.matchCase ? url.spec : url.lowerSpec
    const last = this.last
    if (last === null) {
      return this.left === 'none' || this.right === 'none'
    }
    const subs = this.subpatterns
    if (subs.length === 0) {
      return matchesLast(this.left, this.right, url, text, 0, last)
    }
    // The first subpattern may carry the left anchor; the rest are found left to right.
    let start = 0
    let index = 1
    if (this.left === 'boundary') {
      if (!startsWithAt(text, 0, subs[0])) {
        return false
      }
      start = subs[0].text.length
    } else if (this.left === 'subdomain') {
      if (url.hostEnd <= url.hostBegin) {
        return false
      }
      const found = findSubdomainAnchored(url, text, subs[0])
      if (found === -1) {
        return false
      }
      start = found + subs[0].text.length
    } else {
      index = 0
    }
    for (; index < subs.length; index++) {
      const found = find(text, subs[index], start)
      if (found === -1) {
        return false
      }
      start = found + subs[index].text.length
    }
    return matchesLast('none', this.right, url, text, start, last)
  }
}
