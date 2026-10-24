// Usage: node render.mjs < diagram.mmd
// Writes <tmp>/claude-reply-media/<sha1>.png and prints {"file","width","height"},
// the size in CSS px. Needs `rsvg-convert` (brew install librsvg) on PATH.
import { runRendererProcess as spawnSync } from './process.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The terminal cannot recolor image pixels. Select light for a light terminal.
// Keep the upstream Charmtone palette as the default for existing installs.
export const THEME =
  process.env.NEONCOAT_MEDIA_THEME === 'light'
    ? {
        bg: '#ffffff',
        fg: '#202124',
        line: '#5f6368',
        accent: '#4f46e5',
        muted: '#5f6368',
        font: 'DejaVu Sans',
        transparent: true
      }
    : {
        bg: '#201f26',
        fg: '#ecebf0',
        line: '#858392',
        accent: '#8b75ff',
        muted: '#858392',
        font: 'Helvetica Neue',
        transparent: true
      }
// PNG px per CSS px, so the picture stays sharp when the terminal scales it.
export const ZOOM = 3

// ponytail: librsvg has no CSS var() or color-mix(), so resolve the forms
// beautiful-mermaid 1.1.3 emits (hex colors, srgb mixes). Rasterize with
// headless Chrome instead if a newer version emits more.
export function flatten(svg) {
  const vars = {}
  for (const [, name, value] of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+)/g)) {
    vars[name] ??= value.trim() // the inline style comes first and wins
  }

  const args = (list) => {
    const parts = []
    let depth = 0
    let from = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i] === '(') {
        depth++
      } else if (list[i] === ')') {
        depth--
      } else if (list[i] === ',' && depth === 0) {
        parts.push(list.slice(from, i))
        from = i + 1
      }
    }
    return [...parts, list.slice(from)].map((part) => part.trim())
  }
  const rgb = (hex) =>
    hex.length === 4
      ? Array.from(hex.slice(1), (digit) => Number.parseInt(digit + digit, 16))
      : [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const resolve = (expr) => {
    const call = /^(var|color-mix)\((.*)\)$/s.exec(expr.trim())
    if (!call) {
      return expr.trim()
    }

    const list = args(call[2])
    if (call[1] === 'var') {
      return list[0] in vars ? resolve(vars[list[0]]) : resolve(list.slice(1).join(','))
    }

    // color-mix(in srgb, <color> [p%], <color> [p%])
    const [a, b] = list.slice(1).map((part) => /^(.*?)(?:\s+([\d.]+)%)?$/s.exec(part))
    const share = a[2] ? a[2] / 100 : b[2] ? 1 - b[2] / 100 : 0.5
    const [x, y] = [rgb(resolve(a[1])), rgb(resolve(b[1]))]
    const mixed = x.map((v, i) => Math.round(v * share + y[i] * (1 - share)))
    return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }

  let out = ''
  let from = 0
  for (const { index } of svg.matchAll(/\b(?:var|color-mix)\(/g)) {
    if (index < from) {
      continue
    } // nested in the call just resolved

    let end = svg.indexOf('(', index) + 1
    for (let depth = 1; depth > 0 && end < svg.length; end++) {
      depth += svg[end] === '(' ? 1 : svg[end] === ')' ? -1 : 0
    }
    out += svg.slice(from, index) + resolve(svg.slice(index, end))
    from = end
  }

  // No network fonts: librsvg would not fetch them, and the leftover breaks its parser.
  return (out + svg.slice(from)).replace(/@import url\('[^']*'\);/g, '')
}

/** Draws `svg` as <tmp>/claude-reply-media/<sha1 of key>.png and prints its line. */
function cacheFile(key) {
  const dir = join(tmpdir(), 'claude-reply-media')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${createHash('sha1').update(key).digest('hex')}.png`)
}

export function cached(key) {
  const file = cacheFile(key)
  try {
    const bytes = readFileSync(file)
    // A missing/truncated entry must be regenerated, never accepted as blank.
    if (
      bytes.length < 45 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.subarray(-8).toString('hex') !== '49454e44ae426082'
    ) {
      return undefined
    }
    const width = bytes.readUInt32BE(16) / ZOOM,
      height = bytes.readUInt32BE(20) / ZOOM
    return width > 0 && height > 0 ? { file, width, height } : undefined
  } catch {
    return undefined
  }
}

export function rasterize(svg, key) {
  const file = cacheFile(key)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    const png = spawnSync(
      'rsvg-convert',
      ['--zoom', String(ZOOM), '--background-color', THEME.bg, '--output', temporary],
      {
        input: svg
      }
    )
    if (png.status !== 0) {
      throw new Error(String(png.stderr || png.error))
    }
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }

  const ihdr = readFileSync(file).subarray(16, 24)
  const [width, height] = [ihdr.readUInt32BE(0) / ZOOM, ihdr.readUInt32BE(4) / ZOOM]
  console.log(JSON.stringify({ file, width, height }))
}

const ORDER = '"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",'

/**
 * A module load hook: beautiful-mermaid with ELK's DFS_NODE_ORDER cycle
 * breaker. ELK's default may draw the node a loop goes back from before the
 * node it goes back to (a retry loop as start → ok? → try); walking the graph
 * from the node written first, a loop is drawn the way it reads, also one that
 * returns to that first node.
 */
// shortcut: patches beautiful-mermaid 1.1.3's built file by text; a version
// without that line loads unpatched, which render.test.mjs catches.
export function withModelOrder(url, context, nextLoad) {
  const loaded = nextLoad(url, context)
  if (!url.endsWith('/beautiful-mermaid/dist/index.js')) {
    return loaded
  }
  const source = String(loaded.source).replace(
    ORDER,
    `${ORDER} "elk.layered.cycleBreaking.strategy": "DFS_NODE_ORDER",`
  )
  return { ...loaded, source }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Loaded here, not imported above: the hook must be in place first, and
  // math.mjs, which imports this file, needs no mermaid.
  registerHooks({ load: withModelOrder })
  const { renderMermaidSVG } = await import('beautiful-mermaid')
  // A `---` frontmatter block (config, title) is dropped: the colors are
  // THEME's, and beautiful-mermaid rejects a diagram that opens with one.
  const source = readFileSync(0, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  // Named by theme and source, so a restyle never shows a picture drawn before it.
  rasterize(flatten(renderMermaidSVG(source, THEME)), JSON.stringify(THEME) + source)
}
