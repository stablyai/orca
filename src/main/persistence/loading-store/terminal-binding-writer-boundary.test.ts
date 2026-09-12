import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Pins direct binding assignments so new writers cannot bypass durability review silently.
 * This is only a syntax tripwire: aliases, deletes and replacement objects can evade it.
 * Behavioral durability coverage lives in persistence-flush-and-save-scheduling.test.ts.
 */
const TERMINAL_BINDING_WRITER_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'terminal-binding-writer-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

/** May only ever be DECREASED, by removing a binding writer. Raising it is never the fix. */
const BINDING_WRITER_PIN = 11

// Assignment to a binding field: a property access or index expression on one of the five
// names, then `=` (or a compound `??=` / `||=` / `&&=`) not followed by `=`.
const ASSIGNMENT_PATTERN =
  /(?:\.(?:ptyIdsByLeafId|ptyId|root|terminalPtyIncarnationsByPaneKey|terminalSurfaceTombstonesByPaneKey)|(?:ptyIdsByLeafId|terminalPtyIncarnationsByPaneKey|terminalSurfaceTombstonesByPaneKey)\s*(?:\?\.)?\[[^\]\n]*\])\s*(?:\?\?|\|\||&&)?=(?!=)/

const SCANNED_ROOT = 'src/main'
const SCANNED_EXTENSIONS = ['.ts']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(path) ||
    path.includes('/__tests__/')
  )
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/** Drop comment-only lines so prose naming a field is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('terminal binding writer boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..', '..')
  const files = collectSourceFiles(join(repoRoot, SCANNED_ROOT))
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
    .filter((path) => ASSIGNMENT_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('scans a plausible number of files', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no binding writer outside the allowlist', () => {
    const unlisted = offenders.filter((path) => !TERMINAL_BINDING_WRITER_ALLOWLIST.includes(path))
    expect(
      unlisted,
      'New writer of a terminal binding value. It must bump the persistence write generation ' +
        '(scheduleSave, flushOrThrow, or setWorkspaceSession) in the same operation, or ' +
        "persistPtyBinding's fast path can skip a flush it needed. " +
        'Verify durability in persistence-flush-and-save-scheduling.test.ts; ' +
        'this scanner does not prove the writer advances the generation.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = TERMINAL_BINDING_WRITER_ALLOWLIST.filter((path) => !offenders.includes(path))
    expect(stale, 'Allowlist entry no longer writes a binding value — delete the line.').toEqual([])
  })

  it('holds the writer count at the pin', () => {
    // The pin is a literal so a swap (one writer removed, one added with its entry) cannot pass.
    expect(
      offenders.length,
      `${offenders.length} files write terminal binding values; the pin is ${BINDING_WRITER_PIN}. ` +
        'Never raise the pin -- route the write through a path that bumps the write generation.'
    ).toBeLessThanOrEqual(BINDING_WRITER_PIN)
    expect(
      offenders.length,
      `Only ${offenders.length} files write terminal binding values. Lower BINDING_WRITER_PIN to ` +
        `${offenders.length} to keep the ground you just took.`
    ).toBeGreaterThanOrEqual(BINDING_WRITER_PIN)
  })
})
