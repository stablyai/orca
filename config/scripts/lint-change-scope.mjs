import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AST_GREP_SCAN_PATHS } from './ast-grep-scan.mjs'

// Per-file passes only: each finding depends on one file plus the lint toolchain, so unchanged files cannot regress.
export const LINT_PASS_ROOTS = {
  oxlint: null,
  'js-plugins': ['src', 'config', 'tests', 'mobile', 'native', '.github'],
  'anti-slop': ['src', 'config', 'tests', 'mobile'],
  'ast-grep': AST_GREP_SCAN_PATHS,
  oxfmt: null
}

// Past this the scoped run saves little, and long path lists approach command-line limits.
export const MAX_SCOPED_FILES = 1500

const TOOLCHAIN_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.gitignore',
  '.prettierignore',
  '.oxfmtrc.json',
  '.github/workflows/pr.yml',
  'config/sgconfig.yml',
  'config/flaky-test-pattern-baseline.txt',
  'config/scripts/ast-grep-gates.mjs',
  'config/scripts/ast-grep-scan.mjs',
  'config/scripts/check-flaky-test-pattern-ratchet.mjs',
  'config/scripts/sync-anti-slop-plugin.mjs'
])

const TOOLCHAIN_PREFIXES = [
  'config/oxlint-plugins/',
  'config/ast-grep/',
  'config/scripts/lint-change-scope'
]

// docs/site enables oxlint's import plugin, whose rules can read sibling modules.
const WHOLE_DIRECTORY_SCOPES = ['docs/site/']

export function lintToolchainChange(changedFiles) {
  return changedFiles.find(
    (file) =>
      TOOLCHAIN_FILES.has(file) ||
      TOOLCHAIN_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      /(?:^|\/)\.oxlintrc\.json$/.test(file) ||
      /(?:^|\/)package\.json$/.test(file) ||
      /^config\/oxlint-[^/]+\.json$/.test(file)
  )
}

function underRoots(file, roots) {
  return roots === null || roots.some((root) => file === root || file.startsWith(`${root}/`))
}

/**
 * Returns `{ scope: 'full', reason }` when any pass must lint the whole tree, otherwise the existing
 * changed paths per pass. Deleted paths drop out; a pass with no paths has nothing to check.
 */
export function planLintScope(changedFiles, { exists = existsSync } = {}) {
  if (changedFiles.length === 0) {
    return { scope: 'full', reason: 'No changed paths were detected.' }
  }
  const toolchain = lintToolchainChange(changedFiles)
  if (toolchain) {
    return { scope: 'full', reason: `Lint toolchain input changed: ${toolchain}` }
  }
  if (changedFiles.length > MAX_SCOPED_FILES) {
    return {
      scope: 'full',
      reason: `${changedFiles.length} changed paths exceed the scoped limit.`
    }
  }
  const present = [...new Set(changedFiles)].filter((file) => exists(file)).sort()
  const passes = Object.fromEntries(
    Object.entries(LINT_PASS_ROOTS).map(([pass, roots]) => [
      pass,
      present.filter((file) => underRoots(file, roots))
    ])
  )
  for (const directory of WHOLE_DIRECTORY_SCOPES) {
    if (changedFiles.some((file) => file.startsWith(directory))) {
      passes.oxlint = [
        ...passes.oxlint.filter((file) => !file.startsWith(directory)),
        directory.slice(0, -1)
      ]
    }
  }
  return { scope: 'changed', reason: `${present.length} changed path(s) exist.`, passes }
}

// Usage: lint-change-scope.mjs <nul-delimited changed paths> <output directory>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [changedPath, outputDirectory] = process.argv.slice(2)
  const plan = planLintScope(readFileSync(changedPath, 'utf8').split('\0').filter(Boolean))
  mkdirSync(outputDirectory, { recursive: true })
  for (const [pass, files] of Object.entries(plan.passes ?? {})) {
    writeFileSync(path.join(outputDirectory, pass), files.map((file) => `${file}\0`).join(''))
  }
  console.error(plan.reason)
  process.stdout.write(`${plan.scope}\n`)
}
