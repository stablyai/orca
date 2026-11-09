import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// vitest-shared-worker-file-reset.mjs undoes mocks, module resets, timers, stubs, globals, env
// and cwd after each file. A DOM environment can't be undone, so those files keep their own worker.
// Vitest's fake clock keeps the timer globals present when a worker first uses it.
const CLOCK_TIMER_GLOBAL = String.raw`(?:request|cancel)(?:AnimationFrame|IdleCallback)|(?:set|clear)Immediate|performance|queueMicrotask`
const ISOLATION_REQUIRING_API = new RegExp(
  [
    // Opt-out for a file whose state leaks in ways the reset cannot see.
    String.raw`@orca-isolated-worker\b`,
    String.raw`@vitest-environment\s+(?!node\b)`,
    String.raw`\bglobalThis\.(?:${CLOCK_TIMER_GLOBAL})\s*=[^=]`,
    String.raw`\bstubGlobal\(\s*['"](?:${CLOCK_TIMER_GLOBAL})['"]`,
    String.raw`\bdefineProperty\(\s*globalThis\s*,\s*['"](?:${CLOCK_TIMER_GLOBAL})['"]`
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
