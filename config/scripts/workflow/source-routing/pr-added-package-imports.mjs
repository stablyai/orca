import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

// The packaged CLI loads these trees' tsc output beside node_modules, and main bundles them; a new
// package import can break either in a way only the package jobs check (#48778, #48770).
export const PACKAGED_SOURCE_ROOTS = ['src/main', 'src/cli', 'src/shared']

const BUILTINS = new Set(builtinModules)
// Whole-file patterns, so a declaration or call split across lines still matches.
const DECLARATION_RE = /\b(?:import|export)\s+([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g
// import(), any loader named like require (require.resolve, createRequire's requireFromMain), and a
// chained createRequire(...)('pkg').
const LOADER_CALL_RE =
  /(?:\bimport|\b[\w$]*[Rr]equire[\w$]*(?:\.resolve)?|\))\s*\(\s*['"]([^'"]+)['"]/g

function isPackage(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    specifier !== 'electron' &&
    // Test support outside *.test files (fixtures, mocks) imports these; they never ship.
    specifier !== 'vitest' &&
    !specifier.startsWith('@vitest/') &&
    !BUILTINS.has(specifier.split('/')[0])
  )
}

/** Type-only bindings (`type {…}`, `{ type A, type B }`) load nothing; anything else may. */
function isTypeOnly(bindings) {
  if (/^type\b/.test(bindings)) {
    return true
  }
  const named = /^\{([\s\S]*)\}$/.exec(bindings.trim())?.[1]
  const names = named
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return Boolean(names?.length) && names.every((name) => /^type\b/.test(name))
}

/** The package specifiers a source text may load at runtime. */
export function runtimePackageSpecifiers(source) {
  const specifiers = new Set()
  for (const [, bindings, specifier] of source.matchAll(DECLARATION_RE)) {
    if (!isTypeOnly(bindings)) {
      specifiers.add(specifier)
    }
  }
  for (const re of [SIDE_EFFECT_IMPORT_RE, LOADER_CALL_RE]) {
    for (const [, specifier] of source.matchAll(re)) {
      specifiers.add(specifier)
    }
  }
  return new Set([...specifiers].filter(isPackage))
}

/**
 * Whether a full-context diff gives any non-test file a runtime package specifier its old text
 * didn't have. Each file's old and new text come from the diff itself (context lines are both).
 */
export function addsPackageImport(diff, isTestFile) {
  const files = []
  let inHeader = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files.push({ path: null, before: [], after: [] })
      inHeader = true
    } else if (inHeader) {
      if (line.startsWith('+++ ')) {
        files.at(-1).path = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length)
      }
      inHeader = !line.startsWith('@@')
    } else if (files.length > 0 && !line.startsWith('@@')) {
      const file = files.at(-1)
      if (line.startsWith(' ') || line.startsWith('-')) {
        file.before.push(line.slice(1))
      }
      if (line.startsWith(' ') || line.startsWith('+')) {
        file.after.push(line.slice(1))
      }
    }
  }
  return files.some(({ path, before, after }) => {
    if (!path || isTestFile(path)) {
      return false
    }
    const old = runtimePackageSpecifiers(before.join('\n'))
    return [...runtimePackageSpecifiers(after.join('\n'))].some((specifier) => !old.has(specifier))
  })
}

/**
 * Whether the PR adds a package import. The diff reads only the changed files' blobs, so the
 * router's blob:none checkout stays cheap. A diff it can't read counts as one: packaging runs.
 */
export function prAddsPackageImport(diffBase, isTestFile) {
  try {
    const diff = execFileSync(
      'git',
      [
        'diff',
        // Whole files as context, so a declaration's unchanged lines are still seen.
        '--unified=1000000',
        '--no-renames',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        diffBase,
        'HEAD',
        '--',
        ...PACKAGED_SOURCE_ROOTS
      ],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return addsPackageImport(diff, isTestFile)
  } catch (error) {
    process.stderr.write(
      `pr-added-package-imports: couldn't read the diff, running packaging: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return true
  }
}
