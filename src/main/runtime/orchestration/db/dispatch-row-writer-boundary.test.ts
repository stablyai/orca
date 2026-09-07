import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the live-worker row chokepoint at the tree level rather than per call site.
 *
 * Nesting depth has to be stamped on every row that represents a live supervised
 * worker. Three separate modules used to own their own INSERT, and three review
 * rounds each found one more spawn path than the previous round believed existed.
 * `dispatch-row-writer.ts` owns the statements once; this test is what stops the
 * fourth path from owning one again.
 *
 * Known limit, recorded rather than assumed away: this scans SQL string literals.
 * SQL assembled from a shared table-name constant, split template fragments, or a
 * query builder would evade it — see the detector cases below.
 */
const WRITER_MODULE = 'src/main/runtime/orchestration/db/dispatch-row-writer.ts'

const GUARDED_TABLES = ['dispatch_contexts', 'remote_dispatch_attachments'] as const

/** `INSERT ... INTO <table>`, tolerating OR-clauses and newlines between the words. */
const insertPattern = (table: string): RegExp =>
  new RegExp(String.raw`INSERT\b[\s\S]{0,40}?\bINTO\s+${table}\b`, 'i')

/**
 * Schema DDL, migrations, and reset all legitimately name these tables. They
 * create, alter, and delete rows — they never mint a live worker.
 */
const EXEMPT_PATH_FRAGMENTS = ['/db/schema/', '/db/reset/', '/orchestration-schema-version-skew']

const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture)/.test(path) ||
    path.includes('/__tests__/') ||
    path.includes('/__fixtures__/')
  )
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
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
      found.push(...collectSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(full)
    }
  }
  return found
}

describe('live-worker row insert boundary', () => {
  const repoRoot = resolve(__dirname, '../../../../..')
  const srcRoot = join(repoRoot, 'src')

  it('inserts guarded tables only from dispatch-row-writer.ts', () => {
    const offenders: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const rel = relative(repoRoot, file).split('\\').join('/')
      if (rel === WRITER_MODULE || isTestFile(rel)) {
        continue
      }
      if (EXEMPT_PATH_FRAGMENTS.some((fragment) => rel.includes(fragment))) {
        continue
      }
      const contents = readFileSync(file, 'utf8')
      for (const table of GUARDED_TABLES) {
        if (insertPattern(table).test(contents)) {
          offenders.push(`${rel} inserts ${table}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the writer module actually owns an insert for every guarded table', () => {
    const contents = readFileSync(join(repoRoot, WRITER_MODULE), 'utf8')
    for (const table of GUARDED_TABLES) {
      expect(insertPattern(table).test(contents)).toBe(true)
    }
  })

  it('does not fire on schema DDL, migration DDL, or reset SQL', () => {
    // Why explicit: a naive identifier scan flags all three, which is how the
    // first two drafts of this ratchet failed against their own tree.
    const exempt = [
      'src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts',
      'src/main/runtime/orchestration/db/schema/migrate-v13-v30.ts',
      'src/main/runtime/orchestration/db/reset/orchestration-reset.ts'
    ]
    for (const rel of exempt) {
      expect(
        EXEMPT_PATH_FRAGMENTS.some((fragment) => rel.includes(fragment)),
        `${rel} must be exempt`
      ).toBe(true)
    }
  })

  it('detects the insert forms it claims to detect', () => {
    expect(insertPattern('dispatch_contexts').test('INSERT INTO dispatch_contexts (id)')).toBe(true)
    expect(
      insertPattern('dispatch_contexts').test('INSERT OR REPLACE INTO dispatch_contexts (id)')
    ).toBe(true)
    expect(insertPattern('dispatch_contexts').test('INSERT\n  INTO dispatch_contexts')).toBe(true)
    expect(insertPattern('dispatch_contexts').test('SELECT * FROM dispatch_contexts')).toBe(false)
    expect(insertPattern('dispatch_contexts').test('DELETE FROM dispatch_contexts')).toBe(false)
    // Guards against matching the longer sibling table name by prefix.
    expect(insertPattern('dispatch_contexts').test('INSERT INTO dispatch_contexts_archive')).toBe(
      false
    )
  })

  it('records the evasions this scanner cannot catch', () => {
    // Why asserted rather than commented: these are the scanner's known blind
    // spots. Centralization is the convention; this test only guards the common
    // form. If any of these ever becomes reachable in production SQL, the
    // boundary needs an AST-level check instead.
    const dynamicTable = 'const t = "dispatch_contexts"; db.prepare(`INSERT INTO ${t} (id)`)'
    const splitLiteral = 'db.prepare("INSERT INTO " + "dispatch_contexts (id)")'
    const queryBuilder = 'db.insertInto("dispatch_contexts").values({ id })'
    expect(insertPattern('dispatch_contexts').test(dynamicTable)).toBe(false)
    expect(insertPattern('dispatch_contexts').test(splitLiteral)).toBe(false)
    expect(insertPattern('dispatch_contexts').test(queryBuilder)).toBe(false)
  })
})
