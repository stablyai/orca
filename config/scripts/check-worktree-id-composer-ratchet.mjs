import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet hand-built worktree IDs downward: inconsistent path spellings give one worktree multiple IDs (#30150); use shared/worktree/id.ts composers.

const BASELINE_PATH = 'config/worktree-id-composer-baseline.txt'
const SCAN_ROOTS = ['src', 'mobile/src']
const COMPOSER_FILE = 'src/shared/worktree/id.ts'
const HEADER = [
  '# Hand-built worktree ids (`${repoId}::${path}`) per file, outside src/shared/worktree/id.ts.',
  '# This is a RATCHET: counts may only go DOWN. Compose ids with composeWorktreeId or',
  '# getRepoMainWorktreeId instead. Prune after a fix: pnpm check:worktree-id-composer-ratchet --prune'
]

// A repo-id interpolation, the `::` separator (literal or constant), then a path interpolation.
const HAND_BUILT_WORKTREE_ID =
  /\$\{[^{}]*\b(?:repo\.id|repoId|repo_id)\b[^{}]*\}(?:::|\$\{\s*WORKTREE_ID_SEPARATOR\s*\})\$\{[^{}]*[pP]ath\b[^{}]*\}/g
// Block and line comments; `://` inside a string (a URL) is not a line comment.
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

export function isScannedPath(rel) {
  return (
    SCAN_ROOTS.some((root) => rel.startsWith(`${root}/`)) &&
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    ) &&
    rel !== COMPOSER_FILE
  )
}

export function countHandBuiltWorktreeIds(sourceText) {
  return sourceText.replace(COMMENT, ' ').match(HAND_BUILT_WORKTREE_ID)?.length ?? 0
}

export function collectHandBuiltWorktreeIdCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countHandBuiltWorktreeIds(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'worktree-id-composer',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectHandBuiltWorktreeIdCounts,
      unit: 'hand-built worktree id(s)',
      fix: [
        'Compose worktree ids with composeWorktreeId / getRepoMainWorktreeId (src/shared/worktree/id.ts).'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
