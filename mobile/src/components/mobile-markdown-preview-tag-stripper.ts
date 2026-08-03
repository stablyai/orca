const knownMarkupTagNames = new Set(
  `a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr fencedframe portal selectedcontent
acronym applet basefont bgsound big blink center command content dir element font frame frameset isindex keygen listing marquee menuitem multicol nextid nobr noembed noframes noindex param plaintext rb rtc shadow spacer strike tt xmp
animate animatemotion animatetransform circle clippath defs desc ellipse feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence filter foreignobject g hatch hatchpath image line lineargradient marker mask metadata mpath path pattern polygon polyline radialgradient rect discard set stop svg switch symbol text textpath tspan use view
altglyph altglyphdef altglyphitem animatecolor cursor font-face font-face-format font-face-name font-face-src font-face-uri glyph glyphref hkern missing-glyph solidcolor vkern
annotation annotation-xml maction math menclose merror mfenced mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics`.split(
    /\s+/
  )
)

function followsAttributeEquals(value: string, index: number): boolean {
  let previous = index - 1
  while (previous >= 0 && /\s/.test(value[previous] ?? '')) {
    previous -= 1
  }
  return value[previous] === '='
}

export function findMobileMarkdownMarkupTagEnd(value: string, start: number): number {
  let quote = ''
  for (let index = start; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) {
        quote = ''
      }
      continue
    }
    if ((char === '"' || char === "'") && followsAttributeEquals(value, index)) {
      quote = char
    } else if (char === '<') {
      return -1
    } else if (char === '>') {
      return index
    }
  }
  if (quote) {
    for (let index = start; index < value.length; index += 1) {
      const char = value[index] ?? ''
      if (char === '<') {
        return -1
      }
      if (char === '>') {
        return index
      }
    }
  }
  return -2
}

function nextNestedMarkupCursor(value: string, start: number): number {
  const nestedStart = value.indexOf('<', start + 1)
  if (!followsAttributeEquals(value, nestedStart)) {
    return nestedStart
  }
  const nestedEnd = findMobileMarkdownMarkupTagEnd(value, nestedStart + 1)
  if (nestedEnd < 0) {
    return nestedStart
  }
  return nestedEnd + 1 + Number(value[nestedEnd + 1] === '>')
}

function isMarkupNameStart(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

const markupNameCharPattern = /^[A-Za-z0-9:-]$/

function isMarkupNameChar(char: string): boolean {
  return markupNameCharPattern.test(char)
}

function isPairedMarkupOpenerBoundary(char: string): boolean {
  return char === '>' || /\s/.test(char)
}

export function isPairedMarkupOpener(value: string, nameEnd: number, end: number): boolean {
  if (!isPairedMarkupOpenerBoundary(value[nameEnd] ?? '')) {
    return false
  }
  let lastContent = end - 1
  while (lastContent >= nameEnd && /\s/.test(value[lastContent] ?? '')) {
    lastContent -= 1
  }
  return value[lastContent] !== '/'
}

export function findNextPairedMarkupOpener(
  value: string,
  lowerValue: string,
  name: string,
  cursor: number
): number {
  let start = lowerValue.indexOf(`<${name}`, cursor)
  while (start >= 0) {
    const nameEnd = start + name.length + 1
    const end = findMobileMarkdownMarkupTagEnd(value, nameEnd)
    if (end >= 0 && isPairedMarkupOpener(value, nameEnd, end)) {
      return start
    }
    start = lowerValue.indexOf(`<${name}`, start + name.length + 1)
  }
  return -1
}

export function replaceMobileMarkdownPairedMarkupTags(
  value: string,
  tagNames: readonly string[],
  replacement: (name: string, inner: string) => string
): string {
  const lowerValue = value.toLowerCase()
  const activeNames = new Set(tagNames)
  const nextStarts = new Map<string, number>()
  const nextClosingStarts = new Map<string, number>()
  let output = ''
  let copyCursor = 0
  let searchCursor = 0

  while (activeNames.size > 0 && searchCursor < value.length) {
    let name = ''
    let start = -1
    for (const candidate of activeNames) {
      let candidateStart = nextStarts.get(candidate) ?? -1
      if (candidateStart < searchCursor) {
        candidateStart = findNextPairedMarkupOpener(value, lowerValue, candidate, searchCursor)
        if (candidateStart < 0) {
          activeNames.delete(candidate)
          nextStarts.delete(candidate)
          continue
        }
        nextStarts.set(candidate, candidateStart)
      }
      if (start < 0 || candidateStart < start) {
        name = candidate
        start = candidateStart
      }
    }
    if (start < 0) {
      break
    }

    const nameEnd = start + name.length + 1
    nextStarts.delete(name)
    const end = findMobileMarkdownMarkupTagEnd(value, nameEnd)

    const closingTag = `</${name}>`
    let closingStart = nextClosingStarts.get(name) ?? -1
    if (closingStart < end + 1) {
      closingStart = lowerValue.indexOf(closingTag, end + 1)
      nextClosingStarts.set(name, closingStart)
    }
    if (closingStart < 0) {
      // No later opener of this name can match once its final closer is behind us.
      activeNames.delete(name)
      searchCursor = start + 1
      continue
    }
    const nestedStart = findNextPairedMarkupOpener(value, lowerValue, name, end + 1)
    if (nestedStart >= 0 && nestedStart < closingStart) {
      nextStarts.set(name, nestedStart)
      searchCursor = nestedStart
      continue
    }

    output += value.slice(copyCursor, start)
    output += replacement(name, value.slice(end + 1, closingStart))
    copyCursor = closingStart + closingTag.length
    searchCursor = copyCursor
  }

  return output + value.slice(copyCursor)
}

function isPlaceholderSuffix(value: string, start: number, end: number): boolean {
  let lastNonSpace = ''
  for (let index = start; index < end; index += 1) {
    const char = value[index] ?? ''
    if (char === '=') {
      return false
    }
    if (!/\s/.test(char)) {
      lastNonSpace = char
    }
  }
  return lastNonSpace !== '/'
}

function closingMarkupTagNames(value: string): Set<string> {
  const names = new Set<string>()
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor)
    if (start < 0) {
      return names
    }
    const end = findMobileMarkdownMarkupTagEnd(value, start + 1)
    if (end < 0) {
      if (end === -2) {
        return names
      }
      cursor = nextNestedMarkupCursor(value, start)
      continue
    }
    if (value[start + 1] !== '/' || !isMarkupNameStart(value[start + 2] ?? '')) {
      cursor = end + 1
      continue
    }
    let nameEnd = start + 3
    while (isMarkupNameChar(value[nameEnd] ?? '')) {
      nameEnd += 1
    }
    let boundary = nameEnd
    while (/\s/.test(value[boundary] ?? '')) {
      boundary += 1
    }
    if (boundary === end) {
      names.add(value.slice(start + 2, nameEnd).toLowerCase())
    }
    cursor = end + 1
  }
  return names
}

export function stripMobileMarkdownMarkupTags(value: string): string {
  let output = ''
  let cursor = 0
  const closingTagNames = closingMarkupTagNames(value)
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor)
    if (start < 0) {
      return output + value.slice(cursor)
    }
    output += value.slice(cursor, start)

    const isClosing = value[start + 1] === '/'
    const nameStart = start + (isClosing ? 2 : 1)
    if (!isMarkupNameStart(value[nameStart] ?? '')) {
      output += '<'
      cursor = start + 1
      continue
    }

    let nameEnd = nameStart + 1
    while (isMarkupNameChar(value[nameEnd] ?? '')) {
      nameEnd += 1
    }

    const previousChar = value[start - 1]
    const name = value.slice(nameStart, nameEnd)
    const lowerName = name.toLowerCase()
    const end = findMobileMarkdownMarkupTagEnd(value, nameEnd)
    if (end < 0) {
      if (end === -2) {
        return output + value.slice(start)
      }
      const nestedStart = value.indexOf('<', nameEnd)
      const isNestedGeneric =
        Boolean(previousChar && /\w/.test(previousChar)) &&
        !isClosing &&
        !/[-:]/.test(name) &&
        !knownMarkupTagNames.has(lowerName) &&
        !closingTagNames.has(lowerName)
      if (isNestedGeneric && nestedStart >= 0) {
        output += value.slice(start, nestedStart)
        cursor = nestedStart
        continue
      }
      cursor = nextNestedMarkupCursor(value, start)
      continue
    }

    const suffixStart = value[nameEnd] ?? ''
    const isKnownMarkup = knownMarkupTagNames.has(lowerName)
    const canPreserveOpening = !isClosing && !closingTagNames.has(lowerName)
    const isAutolink =
      /^<[A-Za-z][A-Za-z0-9+.-]+:[^\s<>]*>$/.test(value.slice(start, end + 1)) &&
      nameEnd < end &&
      canPreserveOpening
    const isComparisonAngleText =
      name.length === 1 &&
      suffixStart === '=' &&
      Boolean(previousChar && /\w/.test(previousChar)) &&
      !/\w/.test(value[start - 2] ?? '') &&
      canPreserveOpening
    const isGeneric =
      Boolean(previousChar && /\w/.test(previousChar)) &&
      canPreserveOpening &&
      nameEnd === end &&
      !/[-:]/.test(name) &&
      !isKnownMarkup
    const isTypeParameter =
      canPreserveOpening && nameEnd === end && /^[A-Z]$/.test(name) && !isKnownMarkup
    const tagSuffix = value.slice(nameEnd, end)
    const hasGenericDefault =
      /^\s*=/.test(tagSuffix) || /^\s*(?:extends\b|,)[\s\S]*=/.test(tagSuffix)
    const isGenericDefault =
      Boolean(previousChar && /\w/.test(previousChar)) &&
      canPreserveOpening &&
      /^[A-Z][A-Za-z0-9]*$/.test(name) &&
      !isKnownMarkup &&
      hasGenericDefault &&
      !/\/\s*$/.test(tagSuffix)
    const isUnpairedPlaceholder =
      canPreserveOpening &&
      !isKnownMarkup &&
      isPlaceholderSuffix(value, nameEnd, end) &&
      (!name.includes('-') || tagSuffix.trim().length === 0) &&
      !name.includes(':')

    if (
      isAutolink ||
      isComparisonAngleText ||
      isGeneric ||
      isTypeParameter ||
      isGenericDefault ||
      isUnpairedPlaceholder
    ) {
      output += value.slice(start, end + 1)
    }
    cursor = end + 1
  }
  return output
}
