import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  parseCountBaseline,
  parseCountNotes,
  readTrackedSources,
  runCountRatchet
} from '../../ratchet-baseline/ratchet-baseline.mjs'

// Ratchet raw whole-workspace reads of terminals and pages downward: on a shared agent each person
// has their own tab list, and a read over every record mixes theirs into the host's.

const BASELINE_PATH = 'config/raw-tab-list-read-baseline.txt'
// The runtime owns the PTY records and the page registry; elsewhere `everyPage` is another API's.
const SCAN_ROOTS = ['src/main/runtime', 'src/main/orcad']
const RAW_READ = new RegExp(
  [
    String.raw`\.\s*everyPage\s*\(`,
    String.raw`\bptysById\s*\.\s*(?:values|entries|keys|forEach)\s*\(`,
    String.raw`\bptysById\s*\.\s*size\b`,
    String.raw`\bof\s+[\w.]*\bptysById\s*\)`,
    String.raw`\.\.\.\s*[\w.]*\bptysById\b`,
    String.raw`Array\.from\(\s*[\w.]*\bptysById\b`
  ].join('|'),
  'g'
)
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm
const FIX =
  "use pagesOf / ptyInList for a person's tabs; whole-workspace reads need an allow-list entry with a reason"

export function isScannedPath(rel) {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    )
  )
}

export function countRawTabListReads(sourceText) {
  return sourceText.replace(COMMENT, ' ').match(RAW_READ)?.length ?? 0
}

export function collectRawTabListReadCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countRawTabListReads(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

/** Every allowed file says why it reads the whole workspace. */
export function unexplainedRows(text) {
  const notes = parseCountNotes(text)
  return [...parseCountBaseline(text).keys()].filter((file) => !notes.has(file))
}

export function main(root = process.cwd(), arg = undefined) {
  const baselineFile = path.join(root, BASELINE_PATH)
  const unexplained = fs.existsSync(baselineFile)
    ? unexplainedRows(fs.readFileSync(baselineFile, 'utf8'))
    : []
  for (const file of unexplained) {
    console.error(`${BASELINE_PATH}: ${file} has no '# why'. ${FIX}.`)
  }
  const status = runCountRatchet(
    {
      name: 'raw-tab-list-read',
      baselinePath: BASELINE_PATH,
      header: [
        '# Raw reads over every terminal or page per file: registry everyPage(...) calls and',
        '# iterations over ptysById. This is a RATCHET: counts may only go DOWN.',
        "# A person's tabs read through pagesOf / ptyInList. A whole-workspace read (teardown, removal,",
        '# census, lookup by id) needs a row here: count, file, and a trailing # why.',
        '# Prune after a fix: pnpm check:raw-tab-list-read-ratchet --prune'
      ],
      collect: collectRawTabListReadCounts,
      unit: 'raw tab list read(s)',
      fix: [`${FIX}.`]
    },
    root,
    arg
  )
  return unexplained.length > 0 && arg !== '--prune' ? 1 : status
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
