const { existsSync, readFileSync, statSync } = require('node:fs')
const { dirname, join, posix } = require('node:path')

const WEB_CLIENT_INDEX = 'web-index.html'
const REMEDY = 'Run pnpm build:web-from-renderer (build:desktop and build:release already do).'

function failure(message) {
  return new Error(`[verify-packaged-serve-payload] ${message}`)
}

/** The relative files web-index.html loads; the page is useless if any is missing. */
function referencedAssets(html) {
  const assets = new Set()
  for (const match of html.matchAll(/\b(?:src|href)=["']\.\/([^"'?#]+)/g)) {
    assets.add(posix.normalize(match[1]))
  }
  return [...assets]
}

/**
 * Why: orcad serves the browser client by path from the CLI's own app root, and it runs on plain
 * Node, which cannot read app.asar. So the page and everything it loads must be unpacked beside
 * out/cli, or `orca serve` comes up with no web client (#30100).
 */
function assertPackagedWebClient(resourcesDir) {
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  if (!existsSync(join(outDir, 'cli'))) {
    throw failure(`no unpacked CLI at ${join(outDir, 'cli')}; the web client root resolves from it`)
  }
  const webRoot = join(outDir, 'renderer')
  const manifestPath = join(webRoot, '.orca-web-client-files.json')
  if (!existsSync(manifestPath)) {
    throw failure(`missing unpacked web file manifest at ${manifestPath}. ${REMEDY}`)
  }
  const files = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    !Array.isArray(files) ||
    !files.includes(WEB_CLIENT_INDEX) ||
    !files.every(
      (file) =>
        typeof file === 'string' &&
        (file === WEB_CLIENT_INDEX || /^(?:assets|cmaps|standard_fonts|wasm)\//.test(file)) &&
        !file.includes('\\') &&
        !file.includes('\0') &&
        file.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        !file.endsWith('.map')
    )
  ) {
    throw failure(`invalid web file manifest at ${manifestPath}`)
  }
  const absent = files.filter(
    (file) => !statSync(join(webRoot, file), { throwIfNoEntry: false })?.isFile()
  )
  if (absent.length > 0) {
    throw failure(`missing unpacked web files: ${absent.join(', ')}`)
  }
  const indexPath = join(webRoot, WEB_CLIENT_INDEX)
  if (!existsSync(indexPath)) {
    throw failure(`missing unpacked ${indexPath}. ${REMEDY}`)
  }
  const assets = referencedAssets(readFileSync(indexPath, 'utf8'))
  if (assets.length === 0) {
    throw failure(`${indexPath} references no ./ assets. ${REMEDY}`)
  }
  const missing = assets.filter(
    (asset) =>
      asset.startsWith('..') ||
      !files.includes(asset) ||
      !existsSync(join(webRoot, ...asset.split('/')))
  )
  if (missing.length > 0) {
    throw failure(`${indexPath} loads files missing from ${webRoot}: ${missing.join(', ')}`)
  }
  console.log(`[verify-packaged-serve-payload] OK — ${String(assets.length)} asset(s) unpacked`)
}

// Relative to out/; mirrors ORCAD_LOCAL_SERVE_SELECTION_ENTRY, which a test pins.
const SERVE_SELECTION_ENTRY = 'main/orcad/orcad-local-serve-selection-entry.js'

/** The file Node loads for a relative require, or null when none is unpacked. */
function resolveRequiredFile(path) {
  const candidates = [path, `${path}.js`, `${path}.json`, join(path, 'index.js')]
  return (
    candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile()) ?? null
  )
}

/** Relative requires reachable from `entry`, so a packed chunk fails here and not at serve time. */
function missingRelativeRequires(entry) {
  const missing = new Set()
  const visited = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\brequire\(["'](\.{1,2}\/[^"']+)["']\)/g
    )) {
      const required = join(dirname(file), match[1])
      const resolved = resolveRequiredFile(required)
      if (!resolved) {
        missing.add(required)
      } else if (!visited.has(resolved)) {
        visited.add(resolved)
        queue.push(resolved)
      }
    }
  }
  return [...missing]
}

/**
 * Why: `orca serve` asks this entry which host to serve on, running it on the app's executable
 * as plain Node, which cannot read app.asar. A packed copy made every serve fall back (#27404).
 */
function assertPackagedServeSelectionEntry(resourcesDir) {
  const entry = join(resourcesDir, 'app.asar.unpacked', 'out', ...SERVE_SELECTION_ENTRY.split('/'))
  if (!existsSync(entry)) {
    throw failure(`missing unpacked ${entry}; orca serve runs it under ELECTRON_RUN_AS_NODE`)
  }
  const missing = missingRelativeRequires(entry)
  if (missing.length > 0) {
    throw failure(`${entry} requires files missing from the unpacked app: ${missing.join(', ')}`)
  }
  console.log('[verify-packaged-serve-payload] OK — serve-selection entry unpacked')
}

module.exports = {
  SERVE_SELECTION_ENTRY,
  assertPackagedServeSelectionEntry,
  assertPackagedWebClient
}
