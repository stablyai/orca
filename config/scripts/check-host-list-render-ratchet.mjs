import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on JSX drawn straight from a host collection (`hosts.map((h) => <Row …/>)`). A generated
// ~/.ssh/config can import >10k SSH hosts, and drawing a row per host crashed the renderer. Host
// lists go through src/renderer/src/components/host-picker (bounded, searchable). Counts per file
// may only go down.

const BASELINE_PATH = 'config/host-list-render-baseline.txt'
const SCAN_ROOT = 'src/renderer/src'
const PRIMITIVE_DIR = 'src/renderer/src/components/host-picker/'
const HEADER = [
  '# JSX mapped straight over a host collection, per file, outside components/host-picker.',
  '# This is a RATCHET: counts may only go DOWN. Draw host lists with HostCombobox or',
  '# useBoundedHostRows. Prune after a fix: pnpm check:host-list-render-ratchet --prune'
]

// `<name>.map(` where the name says host/target/ssh/machine, whose callback returns JSX directly.
const HOST_COLLECTION_JSX_MAP =
  /\b[\w.]*(?:[hH]ost|[tT]arget|[sS]sh|SSH|[mM]achine)\w*\.map\(\s*(?:\([^()]*\)|\w+)\s*=>\s*(?:\(\s*)?</g
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

export function isScannedPath(rel) {
  return (
    rel.startsWith(`${SCAN_ROOT}/`) &&
    rel.endsWith('.tsx') &&
    !/\.(test|spec)\.tsx$/.test(rel) &&
    !rel.startsWith(PRIMITIVE_DIR)
  )
}

export function countHostCollectionJsxMaps(sourceText) {
  return sourceText.replace(COMMENT, ' ').match(HOST_COLLECTION_JSX_MAP)?.length ?? 0
}

export function collectHostListRenderCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, [SCAN_ROOT], isScannedPath)) {
    const count = countHostCollectionJsxMaps(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'host-list-render',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectHostListRenderCounts,
      unit: 'host collection JSX map(s)',
      fix: [
        'A host list can hold every configured SSH host (10k+ for a generated ~/.ssh/config).',
        'Draw it through src/renderer/src/components/host-picker: HostCombobox for a single',
        'choice, useBoundedHostRows (+ HostListSearchField, HostListOverflowNote) for a checklist.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
