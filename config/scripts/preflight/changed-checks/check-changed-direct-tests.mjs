import path from 'node:path'

// Why: `vitest related` follows the whole import graph; a leaf module under src/main reaches
// ~1,800 test files through app entry points. CI runs the full suite, so locally only tests that
// name a changed module are worth their CPU.
const UNIT_TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/
const SPECIFIER =
  /(?:from|import|require|mock|importActual|importOriginal|doMock)\s*\(?\s*['"]([^'"\n]+)['"]/g
const ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]

function moduleKey(file) {
  const withoutExtension = SCRIPT_EXTENSION.test(file) ? file.replace(SCRIPT_EXTENSION, '') : file
  return withoutExtension.replace(/\/index$/, '')
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One `git grep` pattern for specifiers ending in a changed module's name (`dir` or `dir/index`).
export function importerPattern(files) {
  const names = new Set()
  for (const file of files) {
    names.add(escapeRegExp(path.posix.basename(moduleKey(file))))
    names.add(escapeRegExp(path.posix.basename(file).replace(SCRIPT_EXTENSION, '')))
  }
  return `['"/](${[...names].join('|')})(\\.[cm]?[jt]sx?)?['"]`
}

function resolveSpecifier(testFile, specifier) {
  if (specifier.startsWith('.')) {
    return moduleKey(path.posix.normalize(path.posix.join(path.posix.dirname(testFile), specifier)))
  }
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) {
      return moduleKey(target + specifier.slice(alias.length))
    }
  }
  return null
}

/** Test files whose own imports or mocks name one of `changed` (one hop, no transitive fan-out). */
export function selectImportingTests(changed, candidates) {
  const keys = new Set(changed.map(moduleKey))
  const selected = []
  for (const [testFile, source] of candidates) {
    for (const match of source.matchAll(SPECIFIER)) {
      const resolved = resolveSpecifier(testFile, match[1])
      if (resolved && keys.has(resolved)) {
        selected.push(testFile)
        break
      }
    }
  }
  return selected
}

export function isUnitTestFile(file) {
  return UNIT_TEST_FILE.test(file)
}
