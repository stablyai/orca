import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A `.tsx` file sitting next to a `.ts` of the same stem is silently dropped from
 * the program: tsconfig `include` expansion keeps one file per extensionless path
 * and `.ts` outranks `.tsx`. Nothing errors — the file just stops being typechecked,
 * which is the exact hole the typecheck-coverage work exists to close.
 *
 * Why the whole tree rather than a list of roots: a hand-kept list drifts from the
 * tsconfig `include` globs it is meant to shadow, and the gap is invisible.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.cross-version-checkouts'
])
/**
 * Resolution groups, not one ranking: `.mts` and `.cts` are separate module formats
 * that coexist with `.ts`. Only members of the same group shadow each other, so a
 * routine `foo.ts` + `foo.mts` pairing must not be reported.
 */
const EXTENSION_GROUPS = [
  ['.d.ts', '.ts', '.tsx'],
  ['.d.mts', '.mts'],
  ['.d.cts', '.cts']
]
// Within a group tsc prefers the implementation file over the declaration.
const PRIORITY = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts']

function collectFiles(root) {
  let found = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    const fullPath = join(root, entry.name)
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      // Why guarded: a dangling symlink must not fail the sweep with a raw ENOENT.
      try {
        isDirectory = statSync(fullPath).isDirectory()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      found = found.concat(collectFiles(fullPath))
      continue
    }
    found.push(fullPath)
  }
  return found
}

function extensionOf(path) {
  return PRIORITY.filter((extension) => path.endsWith(extension)).sort(
    (left, right) => right.length - left.length
  )[0]
}

/** Exported shape kept pure so the grouping rule is testable without touching the tree. */
export function findShadowedFiles(paths) {
  const shadowed = []
  for (const group of EXTENSION_GROUPS) {
    const byStem = new Map()
    for (const path of paths) {
      const extension = extensionOf(path)
      if (!extension || !group.includes(extension)) {
        continue
      }
      const stem = path.slice(0, -extension.length)
      byStem.set(stem, [...(byStem.get(stem) ?? []), extension])
    }
    for (const [stem, extensions] of byStem) {
      if (extensions.length < 2) {
        continue
      }
      const ordered = PRIORITY.filter((extension) => extensions.includes(extension))
      shadowed.push(`${stem}${ordered[1]} is shadowed by ${stem}${ordered[0]}`)
    }
  }
  return shadowed.sort()
}

describe('typecheck extension shadowing', () => {
  it('has no file hidden from the program by a higher-priority extension', () => {
    const paths = collectFiles(repoRoot).map((file) =>
      relative(repoRoot, file).replaceAll('\\', '/')
    )

    expect(findShadowedFiles(paths)).toEqual([])
  })

  it('reports a .tsx hidden behind a .ts of the same stem', () => {
    expect(findShadowedFiles(['src/a.ts', 'src/a.tsx'])).toEqual([
      'src/a.tsx is shadowed by src/a.ts'
    ])
  })

  it('leaves .mts and .cts alone, since they are separate module formats', () => {
    // Verified against tsc --listFilesOnly: a.ts, a.mts and a.cts all enter the
    // program together; only a.tsx is dropped.
    expect(findShadowedFiles(['src/a.ts', 'src/a.mts', 'src/a.cts'])).toEqual([])
  })

  it('still reports shadowing inside the .mts and .cts groups', () => {
    expect(findShadowedFiles(['src/a.mts', 'src/a.d.mts', 'src/b.cts', 'src/b.d.cts'])).toEqual([
      'src/a.d.mts is shadowed by src/a.mts',
      'src/b.d.cts is shadowed by src/b.cts'
    ])
  })
})
