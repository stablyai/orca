// Tag scans only move forward: rescanning from every unclosed opener is quadratic on
// a malformed page, and this parse blocks the main or runtime event loop.

/** Index of the `>` closing a tag, skipping any inside quoted attribute values; -1 when none closes it. */
function findTagEnd(html: string, from: number): number {
  const token = /=[\t\n\f\r ]*(?:(["'])|[^\t\n\f\r >]*)|>/g
  token.lastIndex = from
  for (let match = token.exec(html); match; match = token.exec(html)) {
    if (match[0] === '>') {
      return match.index
    }
    if (match[1]) {
      const close = html.indexOf(match[1], token.lastIndex)
      if (close === -1) {
        return -1
      }
      token.lastIndex = close + 1
    }
  }
  return -1
}

function findCommentEnd(html: string, from: number): number {
  if (html[from] === '>') {
    return from
  }
  if (html.startsWith('->', from)) {
    return from + 1
  }
  const close = /--!?>/g
  close.lastIndex = from
  return close.test(html) ? close.lastIndex - 1 : -1
}

function findRawTextEnd(html: string, name: string, from: number, xml: boolean): number {
  const end = new RegExp(
    `${xml ? '<!--|<!\\[CDATA\\[|<\\?|' : ''}</${name}(?=[\\t\\n\\f\\r />])`,
    'gi'
  )
  end.lastIndex = from
  let boundary = end.exec(html)
  while (xml && boundary && !boundary[0].startsWith('</')) {
    const delimiter = boundary[0] === '<?' ? '?>' : boundary[0] === '<!--' ? '-->' : ']]>'
    const close = html.indexOf(delimiter, end.lastIndex)
    if (close === -1) {
      return -1
    }
    end.lastIndex = close + delimiter.length
    boundary = end.exec(html)
  }
  const closing = boundary?.index ?? -1
  if (xml || name !== 'script' || closing === -1) {
    return closing
  }
  const escape = html.slice(from, closing).indexOf('<!--')
  if (escape === -1) {
    return closing
  }
  const close = /<!--(?:-*>)?|-->|<\/?script(?=[\t\n\f\r />])/gi
  close.lastIndex = from + escape
  let escaped = false
  let doubleEscaped = false
  for (let match = close.exec(html); match; match = close.exec(html)) {
    if (match[0] === '<!--') {
      escaped = true
    } else if (match[0].endsWith('>')) {
      escaped = false
      doubleEscaped = false
    } else if (match[0][1] === '/') {
      if (!doubleEscaped) {
        return match.index
      }
      doubleEscaped = false
    } else if (escaped) {
      doubleEscaped = true
    }
  }
  return -1
}

type HtmlTag = { name: string; attributesStart: number; end: number; contentEnd?: number }

export function* scanHtmlTags(html: string, wanted: Set<string>, xml: boolean): Generator<HtmlTag> {
  let names = [...wanted].join('|')
  let target = new RegExp(`<(?:${names})(?=[\\t\\n\\f\\r />])`, 'gi')
  const candidate = new RegExp(
    `<(?:${names}|script|style|title|textarea|xmp|iframe|noembed|noframes|plaintext)(?=[\\t\\n\\f\\r />])|<!|<\\?|=[\\t\\n\\f\\r ]*(?:"[^">]*>|'[^'>]*>)`,
    'gi'
  )
  const open = /<!--|<!|<\?|<(\/?)([a-z][^\t\n\f\r />]*)/gi
  let targetIndex = -1
  let foundTarget = false
  let scanThrough = -1
  while (true) {
    const less = html.indexOf('<', open.lastIndex)
    if (less === -1) {
      return
    }
    if (open.lastIndex > scanThrough) {
      const remaining = [...wanted].join('|')
      if (remaining !== names) {
        names = remaining
        target = new RegExp(`<(?:${names})(?=[\\t\\n\\f\\r />])`, 'gi')
        targetIndex = -1
      }
      if (foundTarget && targetIndex < open.lastIndex) {
        target.lastIndex = less
        const next = target.exec(html)
        if (!next) {
          return
        }
        targetIndex = next.index
      }
      candidate.lastIndex = less
      const next = candidate.exec(html)
      if (!next) {
        return
      }
      if (next[0][0] === '=') {
        // A quoted `>` requires forward parsing to find its enclosing tag.
        scanThrough = next.index + next[0].length
        open.lastIndex = less
      } else {
        // The scan detects quoted `>` and inert openers, so the previous delimiter ends ordinary tags.
        open.lastIndex =
          less === next.index
            ? less
            : html.indexOf('<', Math.max(open.lastIndex, html.lastIndexOf('>', next.index - 1) + 1))
      }
    }
    const match = open.exec(html)
    if (!match) {
      return
    }
    if (match[0] === '<!--' || match[0] === '<!' || match[0] === '<?') {
      const end =
        match[0] === '<!--'
          ? findCommentEnd(html, open.lastIndex)
          : html.indexOf('>', open.lastIndex)
      if (end === -1) {
        return
      }
      open.lastIndex = end + 1
      continue
    }
    const name = match[2].toLowerCase()
    const attributesStart = open.lastIndex
    const end = findTagEnd(html, attributesStart)
    if (end === -1) {
      return
    }
    open.lastIndex = end + 1
    if (match[1]) {
      continue
    }
    let contentEnd: number | undefined
    if (xml && html[end - 1] === '/') {
      contentEnd = end + 1
    } else if (/^(script|style|title|textarea|xmp|iframe|noembed|noframes)$/.test(name)) {
      contentEnd = findRawTextEnd(html, name, open.lastIndex, xml)
      if (contentEnd === -1) {
        return
      }
      const closingEnd = findTagEnd(html, contentEnd + name.length + 2)
      if (closingEnd === -1) {
        return
      }
      open.lastIndex = closingEnd + 1
    } else if (name === 'plaintext') {
      return
    }
    if (wanted.has(name)) {
      foundTarget = true
      yield { name, attributesStart, end, contentEnd }
    }
  }
}
