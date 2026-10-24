import { common, createLowlight } from 'lowlight'

type SyntaxNode = {
  type: string
  value?: unknown
  properties?: { className?: unknown }
  children?: readonly SyntaxNode[]
}
export type CodeToken = { offset?: number; text: string; classes: string[] }
let highlighter: ReturnType<typeof createLowlight> | null = null
const cache = new Map<string, { tokens: CodeToken[]; characters: number }>()
let cachedCharacters = 0
const MAX_HIGHLIGHT_CHARACTERS = 40_000
const MAX_TOKENS = 2_000

/** Uses the same highlight.js grammars as desktop's rehype-highlight, without an HTML/WebView. */
export function highlightMobileCode(code: string, language?: string): CodeToken[] {
  const name = language?.trim().split(/\s+/, 1)[0]?.toLowerCase()
  const plain = () => [{ text: code, classes: [] }]
  if (!name || code.length > MAX_HIGHLIGHT_CHARACTERS) {
    return plain()
  }
  const key = `${name}\0${code}`
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached.tokens
  }
  const engine = (highlighter ??= createLowlight(common))
  if (!engine.registered(name)) {
    return plain()
  }
  const tokens: CodeToken[] = []
  function visit(node: SyntaxNode, parent: string[] = []) {
    if (tokens.length > MAX_TOKENS) {
      return
    }
    if (node.type === 'text' && typeof node.value === 'string') {
      tokens.push({ text: node.value, classes: parent })
    } else {
      const own = node.properties?.className
      const classes = Array.isArray(own)
        ? own.filter((value): value is string => typeof value === 'string')
        : []
      for (const child of node.children ?? []) {
        visit(child, [...parent, ...classes])
      }
    }
  }
  try {
    visit(engine.highlight(name, code))
  } catch {
    return plain()
  }
  if (tokens.length > MAX_TOKENS || tokens.map((token) => token.text).join('') !== code) {
    return plain()
  }
  let offset = 0
  for (const token of tokens) {
    token.offset = offset
    offset += token.text.length
  }
  cache.set(key, { tokens, characters: code.length })
  cachedCharacters += code.length
  for (const [oldest, entry] of cache) {
    if (cache.size <= 32 && cachedCharacters <= 256_000) {
      break
    }
    cache.delete(oldest)
    cachedCharacters -= entry.characters
  }
  return tokens
}
