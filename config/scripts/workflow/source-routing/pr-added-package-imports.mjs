import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

// The packaged CLI loads these trees' tsc output beside node_modules, and main bundles them; a new
// package import can break either in a way only the package jobs check (#48778, #48770).
export const PACKAGED_SOURCE_ROOTS = ['src/main', 'src/cli', 'src/shared']

const BUILTINS = new Set(builtinModules)
// A runtime import, re-export or import() of a bare specifier, or a call to any loader named like
// require (require.resolve, createRequire's requireFromMain). One-line type-only forms don't load;
// a multi-line one's `} from` line can't tell, so it counts.
const BARE_IMPORT_RE =
  /(?:^\s*import\s+(?!type\b)[^'"]*?\bfrom\s*|^\s*import\s*|^\s*export\s+(?!type\b)[^'"]*?\bfrom\s*|^\s*\}\s*from\s*|\b[\w$]*[Rr]equire[\w$]*(?:\.resolve)?\(\s*|\bimport\(\s*)['"]([^'"./][^'"]*)['"]/
// `import {` or `export {` whose specifier is on a later line.
const OPENS_DECLARATION_RE = /^\s*(?:import\s+(?!type\b)[^'"=;]*|export\s*)\{\s*$/
const CLOSES_DECLARATION_RE = /^\s*\}\s*from\s*['"]/

function isPackage(specifier) {
  return (
    !specifier.startsWith('node:') &&
    specifier !== 'electron' &&
    // Test support outside *.test files (fixtures, mocks) imports these; they never ship.
    specifier !== 'vitest' &&
    !specifier.startsWith('@vitest/') &&
    !BUILTINS.has(specifier.split('/')[0])
  )
}

/**
 * Whether a unified -U0 diff adds a runtime import of a package outside test files. A declaration
 * opened by an added line but closed by an unchanged one (`import type {` made `import {`) has a
 * specifier the diff doesn't show, so it counts.
 */
export function addsPackageImport(diff, isTestFile) {
  let file = null
  let open = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('@@')) {
      if (open) {
        return true
      }
      if (line.startsWith('+++ ')) {
        file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length)
      }
      continue
    }
    if (!file || isTestFile(file) || !line.startsWith('+')) {
      continue
    }
    const added = line.slice(1)
    if (open && CLOSES_DECLARATION_RE.test(added)) {
      open = false
    } else if (OPENS_DECLARATION_RE.test(added)) {
      open = true
    }
    const specifier = BARE_IMPORT_RE.exec(added)?.[1]
    if (specifier && isPackage(specifier)) {
      return true
    }
  }
  return open
}

/**
 * Whether the PR adds a package import, reading only the changed files' blobs so the router's
 * blob:none checkout stays cheap. A diff it can't read counts as one: packaging runs.
 */
export function prAddsPackageImport(diffBase, isTestFile) {
  try {
    const diff = execFileSync(
      'git',
      [
        'diff',
        '-U0',
        '--no-renames',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        diffBase,
        'HEAD',
        '--',
        ...PACKAGED_SOURCE_ROOTS
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return addsPackageImport(diff, isTestFile)
  } catch (error) {
    process.stderr.write(
      `pr-added-package-imports: couldn't read the diff, running packaging: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return true
  }
}
