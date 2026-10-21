import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { stripSlashComments } from './check-path-literal-ratchet.mjs'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on host decisions read off a repo row's legacy `connectionId` (Codex review 6 #4). A row
// may name its SSH host only as `executionHostId: 'ssh:<target>'`, so a raw `repo.connectionId`
// check answers "local" for it and runs remote work on this machine. Counts may only shrink.
// A lower bound, not a proof: destructuring, indexed access and rows not named `*repo*`/`*Repo*`
// are not seen, and the renderer is out of scope.

const BASELINE_PATH = 'config/repo-host-read-baseline.txt'
const SCAN_ROOTS = ['src/main/', 'src/shared/', 'src/cli/']
// A property read on a repo-named receiver; an assignment target is a write, not a decision.
// `repo`, `sourceRepo`, `repoRow`; not `report` or `repos`.
const RAW_READ = /\b(?:repo|\w*Repo)(?:[A-Z]\w*)?!?\??\.connectionId\b(?!\s*=(?!=))/g

/** Files that define what the two spellings mean, with the reason. Keep each reason true. */
export const RESOLVER_FILES = new Map([
  ['src/shared/execution-host.ts', 'the canonical resolvers read both spellings by definition'],
  ['src/main/repo-execution-host.ts', 'the main-process gates built on those resolvers'],
  [
    'src/main/ipc/worktrees/listing/worktree-host-ownership.ts',
    'ownership evidence must see a contradictory row as contradictory'
  ]
])

export function isScannedFile(rel) {
  return (
    rel.endsWith('.ts') &&
    !rel.endsWith('.d.ts') &&
    !/\.(?:test|spec)\.ts$|fixture/.test(rel) &&
    !RESOLVER_FILES.has(rel)
  )
}

// Copying the field verbatim into a projected row decides nothing; that row's reader does.
const VERBATIM_COPY =
  /\.\.\.\(\s*(\w+)\.connectionId !== undefined \? \{ connectionId: \1\.connectionId \} : \{\}\s*\)/g

/** Raw `<repo>.connectionId` reads in one file's code; comments are prose and do not count. */
export function countRawRepoHostReads(text) {
  const code = stripSlashComments(text).replace(VERBATIM_COPY, '')
  return [...code.matchAll(RAW_READ)].length
}

export function collectRepoHostReads(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, text] of readTrackedSources(root, SCAN_ROOTS, isScannedFile)) {
    const count = countRawRepoHostReads(text)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'repo-host-read',
      baselinePath: BASELINE_PATH,
      unit: 'raw repo connectionId read(s)',
      header: [
        "# Raw reads of a repo row's legacy `connectionId` (Codex review 6 #4), as `<count> <file>`.",
        '# This is a RATCHET: counts may only go DOWN. Resolve the host instead (see fix text).',
        '# A lower bound: destructured and differently named rows are not counted.',
        '# Prune after a fix: pnpm check:repo-host-read-ratchet --prune'
      ],
      collect: collectRepoHostReads,
      fix: [
        "Resolve the row's host instead of reading `connectionId` (src/shared/execution-host.ts):",
        '  getRepoRoutingConnectionId(repo)  drop-in for `repo.connectionId` in a routing/SSH check',
        '  getRepoExecutionHostId(repo)      the host id, for comparisons and host-scoped lookups',
        '  requireRepoLocalGitRoute(repo)    (src/main/repo-execution-host.ts) before local Git'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
