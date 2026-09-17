import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  UNCHECKED_RPC_READERS,
  type UncheckedRpcReaderEntry
} from './unchecked-rpc-reader-inventory'

/**
 * Ratchet for unchecked reply readers.
 *
 * `rpcUncheckedPayloadReader('x')` says nothing about the payload: it answers `compatible: true`
 * for a string, a null, an error envelope and the shape the consumer expects alike. The operation
 * then hands that value to a consumer typed as if it had been checked. This list is what the
 * count-down to zero is measured against, and this test is what makes it bind.
 *
 * Three failures, all of which mean "edit the list":
 *   - a file holds an unchecked reader and is on the list of none,
 *   - a listed file no longer holds one (stale entry — how allow-lists rot),
 *   - a listed file's reader count went up.
 *
 * What this does NOT catch, all accepted:
 *   - A hand-written `{ compatible: true, value: raw as T }` reader. Same hole, different bytes;
 *     `unchecked-rpc-reader-inventory.ts` says so in prose because no AST rule separates a
 *     projecting reader that validated its input from one that asserted.
 *   - Whether a *checked* schema is any good. A `z.unknown()` reader counts as checked here and is
 *     the right answer for a payload the consumer forwards opaquely; it is the wrong answer for one
 *     it destructures, and only the consumer trace tells the two apart.
 *   - Test files. `*.test.ts(x)` is not scanned: a suite asserting on an unchecked reader is
 *     testing the helper, and a test does not ship.
 */

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])

/** The three helpers, and the module that defines them — it is not an offender. */
const UNCHECKED_READER_NAMES = new Set([
  'rpcUncheckedPayloadReader',
  'rpcUncheckedMemberReader',
  'rpcReadUnchecked'
])
// Only the module that defines the readers: the AST counter counts calls, and the inventory names
// them in prose alone.
const SELF_FILES = new Set(['src/transport/rpc-reader-payload.ts'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return [path]
  })
}

function parse(path: string, source: string): ts.SourceFile {
  const extension = extname(path)
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** How many unchecked readers this file builds. Only a call counts: an import is not a reader. */
function uncheckedReaderCount(path: string, source: string): number {
  let readers = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      UNCHECKED_READER_NAMES.has(node.expression.text)
    ) {
      readers += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return readers
}

const scanned = scannedRoots
  .flatMap(sourceFiles)
  .filter((path) => sourceExtensions.has(extname(path)))
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => relative(mobileRoot, path).split(/[/\\]/).join('/'))
  .filter((file) => !SELF_FILES.has(file))

const observed = new Map(
  scanned
    .map(
      (file) =>
        [
          file,
          uncheckedReaderCount(join(mobileRoot, file), readFileSync(join(mobileRoot, file), 'utf8'))
        ] as const
    )
    .filter(([, readers]) => readers > 0)
)

const inventory: readonly UncheckedRpcReaderEntry[] = UNCHECKED_RPC_READERS

describe('unchecked RPC reader boundary', () => {
  const probe = join(mobileRoot, 'src', 'transport', 'probe.ts')

  it('counts every shape that builds an unchecked reader', () => {
    expect(uncheckedReaderCount(probe, "read: rpcUncheckedPayloadReader('x')")).toBe(1)
    expect(uncheckedReaderCount(probe, "read: rpcUncheckedMemberReader('x', 'entries')")).toBe(1)
    expect(uncheckedReaderCount(probe, "return rpcReadUnchecked('x', raw)")).toBe(1)
    expect(uncheckedReaderCount(probe, "a(rpcReadUnchecked('x', rpcReadUnchecked('y', 1)))")).toBe(
      2
    )
  })

  it('does not count prose, an import or a checked reader', () => {
    expect(uncheckedReaderCount(probe, '// rpcUncheckedPayloadReader is the old shape')).toBe(0)
    expect(uncheckedReaderCount(probe, '/* rpcReadUnchecked */ export const x = 1')).toBe(0)
    expect(
      uncheckedReaderCount(
        probe,
        "import { rpcUncheckedPayloadReader } from './rpc-reader-payload'"
      )
    ).toBe(0)
    expect(uncheckedReaderCount(probe, "read: rpcResultVariant('x', schema)")).toBe(0)
  })

  it('scans a plausible number of files', () => {
    // A broken root or extension filter would make every check below vacuously pass. The file floor
    // is safe to hold at a constant; the offender floor is not, because the list counts down to
    // zero — it was 20 and this step reached it. Against the list instead, the check survives every
    // step of the countdown: a filter that scanned nothing reports 0 against a list naming 20.
    expect(scanned.length).toBeGreaterThan(400)
    expect(observed.size).toBe(inventory.length)
  })

  it('lists each file once', () => {
    const seen = inventory.map((entry) => entry.file)
    expect(seen.filter((file, index) => seen.indexOf(file) !== index)).toEqual([])
  })

  it('has no unlisted file holding an unchecked reader', () => {
    const listed = new Set(inventory.map((entry) => entry.file))
    const unlisted = [...observed.keys()].filter((file) => !listed.has(file))
    expect(
      unlisted,
      'A new operation validates its reply with rpcResultVariant. Nothing may be added to unchecked-rpc-reader-inventory.ts.'
    ).toEqual([])
  })

  it('has no stale inventory entry', () => {
    const stale = inventory.filter((entry) => !observed.has(entry.file))
    expect(
      stale.map((entry) => entry.file),
      'File holds no unchecked reader — delete its line from unchecked-rpc-reader-inventory.ts.'
    ).toEqual([])
  })

  it('has no inventory entry whose file gained readers', () => {
    const grown = inventory
      .filter((entry) => (observed.get(entry.file) ?? 0) > entry.readers)
      .map((entry) => `${entry.file}: listed ${entry.readers}, found ${observed.get(entry.file)}`)
    expect(grown, 'The counts are a ceiling. Validate the new reply with a schema.').toEqual([])
  })

  it('reports a count that has fallen so the entry can be lowered', () => {
    const overstated = inventory
      .filter(
        (entry) => observed.has(entry.file) && (observed.get(entry.file) ?? 0) < entry.readers
      )
      .map((entry) => `${entry.file}: listed ${entry.readers}, found ${observed.get(entry.file)}`)
    expect(
      overstated,
      'Fewer unchecked readers than listed — lower the count so the ratchet holds.'
    ).toEqual([])
  })
})
