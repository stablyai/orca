import { EmulatorError } from '../emulator-errors'

export type AndroidAxBounds = { left: number; top: number; right: number; bottom: number }

export type AndroidAxNode = {
  className?: string
  text?: string
  resourceId?: string
  contentDesc?: string
  packageName?: string
  clickable?: boolean
  enabled?: boolean
  focused?: boolean
  bounds?: AndroidAxBounds
  children: AndroidAxNode[]
}

// Raw element produced by the parser before mapping to the typed Android node.
type RawElement = { tag: string; attributes: Record<string, string>; children: RawElement[] }

// Parses an Android bounds string "[left,top][right,bottom]" -> AndroidAxBounds,
// or null when the format doesn't match. Coordinates may be negative (off-screen).
export function parseAndroidBounds(value: string): AndroidAxBounds | null {
  const match = value.trim().match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)
  if (!match) {
    return null
  }
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  }
}

// Parses uiautomator dump XML. The returned node is the synthetic root that
// holds the top-level <node> children of <hierarchy>. Throws
// EmulatorError('emulator_error', ...) on unparseable input.
export function parseUiAutomatorXml(xml: string): AndroidAxNode {
  if (xml.trim() === '') {
    throw new EmulatorError('emulator_error', 'Cannot parse empty uiautomator XML')
  }
  let root: RawElement
  try {
    root = parseDocument(xml)
  } catch (error) {
    if (error instanceof EmulatorError) {
      throw error
    }
    throw new EmulatorError(
      'emulator_error',
      `Failed to parse uiautomator XML: ${(error as Error).message}`
    )
  }
  // A bare <node> root is treated as the single top-level node; otherwise take
  // the <node> children of <hierarchy>.
  const topLevel =
    root.tag === 'node' ? [root] : root.children.filter((child) => child.tag === 'node')
  return { children: topLevel.map(mapNode) }
}

function mapNode(raw: RawElement): AndroidAxNode {
  const attrs = raw.attributes
  const node: AndroidAxNode = {
    children: raw.children.filter((child) => child.tag === 'node').map(mapNode)
  }
  // Omit string fields whose attribute is absent or empty (no empty-string fields).
  setString(node, 'className', attrs['class'])
  setString(node, 'text', attrs['text'])
  setString(node, 'resourceId', attrs['resource-id'])
  setString(node, 'contentDesc', attrs['content-desc'])
  setString(node, 'packageName', attrs['package'])
  setBool(node, 'clickable', attrs['clickable'])
  setBool(node, 'enabled', attrs['enabled'])
  setBool(node, 'focused', attrs['focused'])
  const bounds = attrs['bounds'] === undefined ? null : parseAndroidBounds(attrs['bounds'])
  if (bounds) {
    node.bounds = bounds
  }
  return node
}

function setString(
  node: AndroidAxNode,
  key: 'className' | 'text' | 'resourceId' | 'contentDesc' | 'packageName',
  value: string | undefined
): void {
  if (value !== undefined && value !== '') {
    node[key] = value
  }
}

function setBool(
  node: AndroidAxNode,
  key: 'clickable' | 'enabled' | 'focused',
  value: string | undefined
): void {
  if (value === 'true') {
    node[key] = true
  } else if (value === 'false') {
    node[key] = false
  }
}

// Recursive-descent parser for the well-formed XML `uiautomator dump` emits.
// All cursor state is local so the function is pure and reentrant.
function parseDocument(xml: string): RawElement {
  let i = 0
  const n = xml.length

  const fail = (message: string): never => {
    throw new EmulatorError('emulator_error', `${message} at offset ${i}`)
  }
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  const skipWs = (): void => {
    while (i < n && isWs(xml[i])) {
      i++
    }
  }
  const startsWith = (token: string): boolean => xml.startsWith(token, i)
  const skipDelimited = (open: string, close: string, label: string): void => {
    const end = xml.indexOf(close, i + open.length)
    if (end === -1) {
      fail(`Unterminated ${label}`)
    }
    i = end + close.length
  }
  const readName = (): string => {
    const start = i
    while (i < n) {
      const c = xml[i]
      if (isWs(c) || c === '=' || c === '/' || c === '>' || c === '<' || c === '"' || c === "'") {
        break
      }
      i++
    }
    return xml.slice(start, i)
  }

  // Skip prolog: whitespace, <?...?> declarations, comments, and <!DOCTYPE ...>.
  const skipProlog = (): void => {
    for (;;) {
      skipWs()
      if (i >= n) {
        return
      }
      if (startsWith('<?')) {
        skipDelimited('<?', '?>', 'processing instruction')
      } else if (startsWith('<!--')) {
        skipDelimited('<!--', '-->', 'comment')
      } else if (startsWith('<!')) {
        skipDelimited('<!', '>', 'declaration')
      } else {
        return
      }
    }
  }

  const parseElement = (): RawElement => {
    if (xml[i] !== '<') {
      fail('Expected element start')
    }
    i++
    const tag = readName()
    if (tag === '') {
      fail('Expected tag name')
    }
    const attributes: Record<string, string> = {}
    for (;;) {
      skipWs()
      if (i >= n) {
        fail('Unterminated start tag')
      }
      if (xml[i] === '/') {
        if (xml[i + 1] !== '>') {
          fail('Malformed self-closing tag')
        }
        i += 2
        return { tag, attributes, children: [] }
      }
      if (xml[i] === '>') {
        i++
        break
      }
      const name = readName()
      if (name === '') {
        fail('Expected attribute name')
      }
      skipWs()
      if (xml[i] !== '=') {
        fail("Expected '=' after attribute name")
      }
      i++
      skipWs()
      const quote = xml[i]
      if (quote !== '"' && quote !== "'") {
        fail('Expected quoted attribute value')
      }
      i++
      const start = i
      while (i < n && xml[i] !== quote) {
        i++
      }
      if (i >= n) {
        fail('Unterminated attribute value')
      }
      attributes[name] = decodeEntities(xml.slice(start, i))
      i++
    }
    return parseChildren(tag, attributes)
  }

  const parseChildren = (tag: string, attributes: Record<string, string>): RawElement => {
    const children: RawElement[] = []
    for (;;) {
      if (i >= n) {
        fail(`Unterminated element <${tag}>`)
      }
      if (xml[i] !== '<') {
        // Text content between elements carries no node data; skip to next tag.
        while (i < n && xml[i] !== '<') {
          i++
        }
        continue
      }
      if (startsWith('</')) {
        i += 2
        const closeName = readName()
        skipWs()
        if (xml[i] !== '>') {
          fail('Malformed end tag')
        }
        i++
        if (closeName !== tag) {
          fail(`Mismatched end tag </${closeName}> for <${tag}>`)
        }
        return { tag, attributes, children }
      }
      if (startsWith('<!--')) {
        skipDelimited('<!--', '-->', 'comment')
      } else if (startsWith('<![CDATA[')) {
        skipDelimited('<![CDATA[', ']]>', 'CDATA section')
      } else if (startsWith('<?')) {
        skipDelimited('<?', '?>', 'processing instruction')
      } else {
        children.push(parseElement())
      }
    }
  }

  skipProlog()
  if (i >= n || xml[i] !== '<') {
    fail('No root element found')
  }
  return parseElement()
}

// Decodes the predefined XML entities plus numeric character references.
function decodeEntities(value: string): string {
  if (!value.includes('&')) {
    return value
  }
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code =
          body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
        return Number.isNaN(code) ? match : String.fromCodePoint(code)
      }
    }
  })
}
