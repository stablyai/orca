import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  readTrackedSources,
  totalCount
} from './ratchet-baseline.mjs'

// Ratchet on worktree ids built by hand (`${repo.id}::${path}`) instead of through the composers in
// src/shared/worktree/id.ts. About 22 hand-built ids each pick whichever path spelling is at hand,
// which is how one worktree ends up with two ids (#30150). Counts per file may only go down.

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
  const current = collectHandBuiltWorktreeIdCounts(root)
  if (arg === '--prune') {
    const total = pruneCountBaseline(root, BASELINE_PATH, HEADER, current)
    console.log(`worktree-id-composer baseline pruned to ${total}.`)
    return 0
  }
  const baselineFile = path.join(root, BASELINE_PATH)
  const baseline = parseCountBaseline(
    fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : ''
  )
  const { grown, shrunk } = diffCounts(current, baseline)
  for (const { file, now, allowed } of grown) {
    console.error(`${file}: ${now} hand-built worktree id(s), baseline allows ${allowed}.`)
  }
  if (grown.length > 0) {
    console.error(
      'Compose worktree ids with composeWorktreeId / getRepoMainWorktreeId (src/shared/worktree/id.ts).'
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(`${file}: now ${now}, baseline ${allowed}.`)
  }
  if (shrunk.length > 0) {
    console.error(
      'The baseline may only shrink. Fix it: pnpm check:worktree-id-composer-ratchet --prune'
    )
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(`worktree-id-composer ratchet OK — ${totalCount(current)} grandfathered id(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
