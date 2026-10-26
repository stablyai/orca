import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const RENDERER_BUILD_DIR = path.join('out', 'renderer')

// Entry/modulepreload closure is fetched/evaluated before first paint and costs every launch regardless of feature use.
export function readRendererBootGraph(rendererDir) {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8')
  const entries = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(
    (match) => match[1]
  )
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(
    (match) => match[1]
  )
  const files = [...new Set([...entries, ...preloads])]
  const chunks = files.map((href) => {
    const file = path.join(rendererDir, href.replace(/^\.?\//, ''))
    return { href, file, bytes: fs.statSync(file).size }
  })
  return {
    chunks: chunks.sort((left, right) => right.bytes - left.bytes),
    totalBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0)
  }
}

// Match unique payload literals: these features load after first paint/from routes, so a boot-graph hit exposes a regressed static import.
export function bootGraphForbiddenPayloads(root = process.cwd()) {
  return [
    { label: '@xterm/addon-webgl', signature: 'WebGL2 not supported' },
    {
      label: '@xterm/addon-image',
      signature: 'invalid storageLimit, should be at least 0.5 MB and not exceed 1G'
    },
    { label: 'i18n/locales/en.json', signature: prunedAwayEnglishSignature(root) }
    // Exclude zod: other boot-path modules still need it. Keep emojibase-data static: async catalog loading can persist submitted :wink: literally.
  ]
}

// Derive full-catalog-only marker from longest English value pruned at runtime so copy edits cannot stale the guard.
export function prunedAwayEnglishSignature(root = process.cwd()) {
  const flatten = (value, prefix = '', out = new Map()) => {
    if (typeof value === 'string') {
      out.set(prefix, value)
      return out
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return out
    }
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
    return out
  }
  const read = (relative) =>
    flatten(JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')))
  const full = read('src/renderer/src/i18n/locales/en.json')
  const runtimeRequired = read('src/renderer/src/i18n/en-runtime-required.json')
  let longest = ''
  for (const [key, value] of full) {
    if (!runtimeRequired.has(key) && value.length > longest.length) {
      longest = value
    }
  }
  if (longest.length < 40) {
    throw new Error(
      'No sufficiently distinctive pruned English value to probe the boot graph with.'
    )
  }
  return longest
}

export function findForbiddenBootPayloads(rendererDir, payloads) {
  const { chunks } = readRendererBootGraph(rendererDir)
  const violations = []
  for (const chunk of chunks) {
    const code = fs.readFileSync(chunk.file, 'utf8')
    for (const payload of payloads) {
      if (code.includes(payload.signature)) {
        violations.push({ label: payload.label, chunk: path.basename(chunk.file) })
      }
    }
  }
  return violations
}

export function verifyRendererBootGraph(root = process.cwd()) {
  const rendererDir = path.join(root, RENDERER_BUILD_DIR)
  const { chunks, totalBytes } = readRendererBootGraph(rendererDir)
  const violations = findForbiddenBootPayloads(rendererDir, bootGraphForbiddenPayloads(root))
  console.log(
    `Renderer boot graph: ${chunks.length} chunks, ${(totalBytes / 1024).toFixed(1)} KB minified.`
  )
  if (violations.length === 0) {
    return 0
  }
  console.error('Payloads that must stay off the renderer boot graph are preloaded again:')
  for (const violation of violations) {
    console.error(`  ${violation.label} -> ${violation.chunk}`)
  }
  console.error('')
  console.error('Load them after first paint (see primeTerminalWebglAddon) or from a route chunk.')
  return 1
}
