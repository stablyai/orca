import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

// The packaged CLI loads these trees' tsc output beside node_modules, and main bundles them; a new
// package import can break either in a way only the package jobs check (#48778, #48770).
export const PACKAGED_SOURCE_ROOTS = ['src/main', 'src/cli', 'src/shared']

const BUILTINS = new Set(builtinModules)
// A runtime import, re-export, require() or import() of a bare specifier. One-line type-only forms
// don't load; a multi-line one's `} from` line can't tell, so it counts.
const BARE_IMPORT_RE =
  /(?:^\s*import\s+(?!type\b)[^'"]*?\bfrom\s*|^\s*import\s*|^\s*export\s+(?!type\b)[^'"]*?\bfrom\s*|^\s*\}\s*from\s*|\brequire\(\s*|\bimport\(\s*)['"]([^'"./][^'"]*)['"]/

/** Whether a unified diff adds a runtime import of a non-builtin package outside test files. */
export function addsPackageImport(diff, isTestFile) {
  let file = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length)
      continue
    }
    if (!file || isTestFile(file) || !line.startsWith('+')) {
      continue
    }
    const specifier = BARE_IMPORT_RE.exec(line.slice(1))?.[1]
    if (specifier && !specifier.startsWith('node:') && specifier !== 'electron') {
      if (!BUILTINS.has(specifier.split('/')[0])) {
        return true
      }
    }
  }
  return false
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
      `pr-added-package-imports: couldn't read the diff, running packaging: ${error}\n`
    )
    return true
  }
}
