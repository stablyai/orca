import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on renderer reads and writes of the project catalog fields (repos, projectGroups,
// projects, projectHostSetups) outside their selector module. The catalog moves to main's feed
// (sidebar design §4 "Project catalog", P5a), so a reader that touches the store field directly
// would keep reading the window's old copy, and a writer would keep writing one. Counts may only
// shrink. A lower bound: reads are counted on store-state receivers (`s`, `state`, `get()`,
// `….getState()`, `ownerState`, `currentState`, `store`, `previous`, `previousState`,
// `closedState`), writes as catalog keys in object
// literals of files that call `set(`; destructuring and computed access are not seen.

const BASELINE_PATH = 'config/project-catalog-read-baseline.txt'
const SCAN_ROOTS = ['src/renderer/src/']
const CATALOG_FIELDS = 'repos|projectGroups|projects|projectHostSetups'
// `state.repos`, `previous.projects` (a subscriber's other state), `get().projectGroups`,
// `useAppStore.getState().projects`; not `args.repos`.
const RAW_READ = new RegExp(
  `(?:(?:[A-Za-z_$][\\w$]*\\.)*getState\\(\\)|get\\(\\)|(?<![\\w$.])(?:s|state|ownerState|currentState|store|previous|previousState|closedState))\\??\\.(?:${CATALOG_FIELDS})\\b`,
  'g'
)
// A catalog key in an object literal (`repos: next`, `{ projects, … }`) of a file that writes the store.
const RAW_WRITE = new RegExp(`(?:^|[{,])\\s*(?:${CATALOG_FIELDS})\\s*(?=[:,}\\n])`, 'gm')

/** Files allowed to read the fields directly, with the reason. Keep each reason true. */
export const SELECTOR_FILES = new Map([
  [
    'src/renderer/src/store/project-catalog-selectors.ts',
    'the selector module is the one read path by definition'
  ],
  [
    'src/renderer/src/lib/main-project-catalog.ts',
    "switch-on, main's catalog as the window reads it: the rows the selectors return"
  ]
])

export function isScannedFile(rel) {
  return (
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !/\.(?:test|spec)\.tsx?$|fixture|test-harness|test-support/.test(rel) &&
    !SELECTOR_FILES.has(rel)
  )
}

/** Drops comments and the contents of quoted strings, so prose and i18n keys never count. */
export function stripCommentsAndQuotedStrings(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "'" || char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== char && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1
      }
      out += `${char}${char}`
      i = j
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end - 1
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
    } else {
      out += char
    }
  }
  return out
}

// Store modules build the patches a `set(` elsewhere writes, so their catalog keys count too.
const STORE_ROOT = 'src/renderer/src/store/'

export function countProjectCatalogAccesses(text, rel = '') {
  const code = stripCommentsAndQuotedStrings(text)
  const reads = [...code.matchAll(RAW_READ)].length
  const writesStore = rel.startsWith(STORE_ROOT) || /\bset(?:State)?\(/.test(code)
  const writes = writesStore ? [...code.matchAll(RAW_WRITE)].length : 0
  return reads + writes
}

export function collectProjectCatalogAccesses(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, text] of readTrackedSources(root, SCAN_ROOTS, isScannedFile)) {
    const count = countProjectCatalogAccesses(text, rel)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'project-catalog-read',
      baselinePath: BASELINE_PATH,
      unit: 'direct project catalog field access(es)',
      header: [
        '# Renderer reads and writes of `repos` / `projectGroups` / `projects` / `projectHostSetups`',
        '# outside src/renderer/src/store/project-catalog-selectors.ts, as `<count> <file> # <why>`.',
        '# This is a RATCHET: counts may only go DOWN. Read through the selectors instead.',
        '# Rows are the catalog writers (P5a gates each one): catalog keys in the objects they write.',
        '# Prune after a fix: pnpm check:project-catalog-read-ratchet --prune'
      ],
      collect: collectProjectCatalogAccesses,
      fix: [
        'Read the project catalog through src/renderer/src/store/project-catalog-selectors.ts:',
        '  selectRepos / selectProjectGroups / selectProjects / selectProjectHostSetups'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
