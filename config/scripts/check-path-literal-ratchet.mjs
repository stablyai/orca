import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parse } from 'jsonc-parser'
import { listTrackedFiles, readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// Ratchet on `src/...` path literals in CI config, workflows and e2e code that name nothing. A
// moved or deleted file silently orphans these hand-kept references (routes, gate manifests,
// workflow `paths:`), so the check runs ahead of folder moves. Known-stale entries may only shrink.

const BASELINE_PATH = 'config/path-literal-baseline.txt'
const SCAN_ROOTS = ['config', '.github', 'tests']
const SOURCE_ROOTS = 'main|renderer|shared|cli|preload|packages|types|wsl-guest'
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts']
// Generated timings; a stale row only skews shard balance and is rewritten by its generator.
const EXCLUDED_FILES = new Set(['config/scripts/ci-shard-timings.json'])
const GATE_MANIFEST = 'config/reliability-gates.jsonc'
// Command strings in manifests and scripts name paths unquoted; in code only quoted literals count.
const UNQUOTED_ALLOWED = /\.(?:jsonc?|ya?ml|sh|ps1)$/
// Comments are prose, not references.
const SLASH_COMMENTED = /\.(?:m?js|cjs|ts|jsonc)$/
const HASH_COMMENT = /^\s*#.*$/gm
// Group 1 is a relative `./` or `../` chain and group 3 a following glob character: a relative
// non-glob, non-folder reference is an import and must resolve exactly, not as a prefix.
const QUOTED_LITERAL = new RegExp(
  `(?:['"\`]|:\\(glob\\))((?:\\.\\.?\\/)*)(src\\/(?:${SOURCE_ROOTS})\\/[\\w@\\-./]*)([*{]?)`,
  'g'
)
const ANY_LITERAL = new RegExp(
  `(?:['"\`\\s=]|:\\(glob\\)|^)((?:\\.\\.?\\/)*)(src\\/(?:${SOURCE_ROOTS})\\/[\\w@\\-./]*)([*{]?)`,
  'gm'
)

export function isScannedPath(rel) {
  return (
    /\.(?:m?js|cjs|ts|jsonc?|ya?ml|ps1|sh)$/.test(rel) &&
    !EXCLUDED_FILES.has(rel) &&
    // Unit tests and fixtures name fake paths on purpose; e2e specs import real ones.
    (/^tests\/e2e\/.*\.spec\.ts$/.test(rel) || !/\.(?:test|spec)\.|fixture|benchmark/.test(rel))
  )
}

/**
 * Drops line and block comments outside string literals, so a quoted glob such as
 * `'src/**\/*.ts'` never opens a comment. Regex literals are read as code; at worst one hides a path.
 */
export function stripSlashComments(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      out += char
      if (char === '\\') {
        out += text[++i] ?? ''
      } else if (char === quote || (char === '\n' && quote !== '`')) {
        quote = null
      }
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end - 1
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
    } else {
      if (char === "'" || char === '"' || char === '`') {
        quote = char
      }
      out += char
    }
  }
  return out
}

/**
 * Every `src/...` literal in one file's code, with a trailing glob or sentence period cut off.
 * Relative imports are marked so they resolve exactly.
 */
export function extractPathLiterals(rel, text) {
  const pattern = UNQUOTED_ALLOWED.test(rel) ? ANY_LITERAL : QUOTED_LITERAL
  const code = SLASH_COMMENTED.test(rel)
    ? stripSlashComments(text)
    : text.replace(HASH_COMMENT, ' ')
  const literals = new Map()
  for (const [, parents, literal, glob] of code.matchAll(pattern)) {
    const key = literal.replace(/\.+$/, '')
    // Any import occurrence makes the literal exact: the strictest reading wins.
    literals.set(
      key,
      (literals.get(key) ?? false) || (parents.length > 0 && !glob && !key.endsWith('/'))
    )
  }
  return [...literals].map(([literal, isImport]) => ({ literal, isImport }))
}

/**
 * A literal resolves when it names a tracked file or a module (without extension, or a folder
 * with `index.ts`). A non-import may also name a folder or a prefix of a tracked file. Only
 * tracked files count, so local leftovers can't change the verdict.
 */
export function createPathResolver(trackedFiles) {
  const tracked = new Set(trackedFiles)
  const sorted = [...tracked].sort()
  const hasPrefix = (prefix) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (sorted[mid] < prefix) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low < sorted.length && sorted[low].startsWith(prefix)
  }
  return (literal, isImport = false) =>
    ['', ...RESOLVED_EXTENSIONS].some((extension) => tracked.has(literal + extension)) ||
    (!isImport && hasPrefix(literal))
}

/** A gate's commands and test files; evidence prose and runs record what ran then. */
export function liveGateReferences(text) {
  return (parse(text).gates ?? [])
    .flatMap((gate) => [...(gate.commands ?? []), ...(gate.testFiles ?? [])])
    .join('\n')
}

export function collectUnresolvedPathLiterals(root = process.cwd()) {
  const resolves = createPathResolver(listTrackedFiles(root, ['src']))
  const entries = []
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const text = rel === GATE_MANIFEST ? liveGateReferences(source) : source
    for (const { literal, isImport } of extractPathLiterals(rel, text)) {
      if (!resolves(literal, isImport)) {
        entries.push(`${rel} ${literal}`)
      }
    }
  }
  return entries.sort()
}

const RATCHET = {
  name: 'path-literal',
  baselinePath: BASELINE_PATH,
  header: [
    '# `<file> <src/... literal>` pairs in config/, .github/ and tests/ that name no tracked file.',
    '# This is a RATCHET: the list may only SHRINK. Fix the reference, then prune:',
    '# pnpm check:path-literal-ratchet --prune'
  ],
  collect: collectUnresolvedPathLiterals,
  fix: [
    'A src/... path in CI config, a workflow or an e2e file names no tracked file. Update it to the',
    "file's new path (a move or rename orphaned it), or drop it if the file is gone."
  ]
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(RATCHET, root, arg)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
