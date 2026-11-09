import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// vitest-shared-worker-file-reset.mjs undoes mocks, timers, stubs, env and cwd after each file.
// These can't be undone between files, so a file that uses them keeps its own worker.
const ISOLATION_REQUIRING_API = new RegExp(
  [
    // Opt-out for a file whose state leaks in ways the reset cannot see.
    String.raw`@orca-isolated-worker\b`,
    String.raw`\bvi\.(?:doMock|unmock|doUnmock|resetModules)\(`,
    String.raw`@vitest-environment\s+(?!node\b)`,
    String.raw`\bglobalThis(?:\.\w+|\[[^\]]+\])\s*=[^=]`,
    String.raw`\bObject\.defineProperty\(\s*(?:globalThis|process|navigator|window|document)\b`
  ].join('|')
)
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js']

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveLocal(fromFile, specifier, aliases) {
  let base = null
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    const alias = aliases.find(({ find }) => specifier === find || specifier.startsWith(`${find}/`))
    if (!alias) {
      return null
    }
    base = join(alias.replacement, specifier.slice(alias.find.length))
  }
  const stem = base.replace(/\.[cm]?jsx?$/, '')
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => stem + extension),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))
  ]
  return (
    candidates.find(
      (candidate) => !/[\\/]node_modules[\\/]/.test(candidate) && isFile(candidate)
    ) ?? null
  )
}

/**
 * Returns the test files (root-relative, forward slashes) that can share a worker's module cache.
 * Only the test file and the test-support files it imports are scanned, not production modules.
 */
export function filesSafeToShareWorker(root, files, aliases = []) {
  const sources = new Map()
  const read = (file) => {
    let source = sources.get(file)
    if (source === undefined) {
      source = readFileSync(file, 'utf8')
      sources.set(file, source)
    }
    return source
  }
  const isTestSupport = (file) => /\bfrom\s+['"]vitest['"]/.test(read(file))
  const memo = new Map()
  const visiting = new Set()
  const requiresIsolation = (file) => {
    const known = memo.get(file)
    if (known !== undefined) {
      return known
    }
    if (visiting.has(file)) {
      return false
    }
    visiting.add(file)
    const source = read(file)
    let result = ISOLATION_REQUIRING_API.test(source)
    for (const match of result ? [] : source.matchAll(IMPORT_SPECIFIER)) {
      const target = resolveLocal(file, match[1], aliases)
      if (target && isTestSupport(target) && requiresIsolation(target)) {
        result = true
        break
      }
    }
    visiting.delete(file)
    memo.set(file, result)
    return result
  }
  return files
    .map((file) => resolve(root, file))
    .filter((file) => isFile(file) && !requiresIsolation(file))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
}
