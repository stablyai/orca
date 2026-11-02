/** The scripts an editor's HTML document runs, read as Chromium would for `orca plugin check`. */

export type HtmlScript = { text: string; module: boolean; lineOffset: number }
export type HtmlScriptSrc = { src: string; module: boolean; line: number; column: number }
/** An import map's `imports`: bare specifier, or a prefix ending in `/`, to a URL. */
export type HtmlImportMap = Record<string, string>

// Chromium's JavaScript MIME types; any other `type` is a data block it never runs.
const JS_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript'
])

export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    attributes
  )
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

function importsOf(json: string): HtmlImportMap {
  try {
    const parsed: unknown = JSON.parse(json)
    const imports =
      typeof parsed === 'object' && parsed !== null && 'imports' in parsed ? parsed.imports : null
    if (typeof imports !== 'object' || imports === null) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(imports).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

/** Inline and `src` scripts Chromium runs, and the document's import map. */
export function readHtmlScripts(html: string): {
  inline: HtmlScript[]
  srcs: HtmlScriptSrc[]
  importMap: HtmlImportMap
} {
  const inline: HtmlScript[] = []
  const srcs: HtmlScriptSrc[] = []
  const importMap: HtmlImportMap = {}
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = (attribute(match[1], 'type') ?? '').trim().toLowerCase()
    if (type === 'importmap') {
      Object.assign(importMap, importsOf(match[2]))
      continue
    }
    if (!JS_TYPES.has(type)) {
      continue
    }
    const module = type === 'module'
    const src = attribute(match[1], 'src')
    if (src !== null) {
      srcs.push({ src, module, ...lineColumn(html, match.index) })
    } else if (match[2].trim()) {
      const contentStart = match.index + match[0].indexOf('>') + 1
      inline.push({ text: match[2], module, lineOffset: lineColumn(html, contentStart).line - 1 })
    }
  }
  return { inline, srcs, importMap }
}

/** The import map's target for a bare specifier: an exact key, else the longest `/` prefix. */
export function resolveImportMapSpecifier(map: HtmlImportMap, specifier: string): string | null {
  if (map[specifier] !== undefined) {
    return map[specifier]
  }
  const prefix = Object.keys(map)
    .filter((key) => key.endsWith('/') && specifier.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  return prefix === undefined ? null : map[prefix] + specifier.slice(prefix.length)
}
