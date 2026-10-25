import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// Ratchet gate for the `@ts-nocheck` directive.
//
// TypeScript only honours `@ts-nocheck` in a comment before the first statement, and
// once present it disables type checking for the ENTIRE file. PR #17605 split a single
// 43,928-line class into ~172 modules whose linear mixin-inheritance chain cannot yet
// express forward references, so each carries a grandfathered `@ts-nocheck` header. This
// check freezes that set (the baseline) and fails CI when a NEW file adds the directive —
// the existing files are grandfathered; new ones must fix their types instead. The
// baseline may only shrink.

const BASELINE_PATH = 'config/ts-nocheck-baseline.txt'
// These two files legitimately contain the directive text as data (regex, fixtures),
// so scanning them would self-flag. The ratchet does not police itself.
const SELF_FILES = new Set([
  'config/scripts/check-ts-nocheck-ratchet.mjs',
  'config/scripts/check-ts-nocheck-ratchet.test.mjs'
])

// True if `@ts-nocheck` appears in a comment before the first statement, matching the
// TypeScript rule. Limitation: only the leading run of blank lines / line comments /
// block comments at the top of the file is scanned, so a directive-looking string deeper
// in a block comment that itself starts at the top is still checked — but anything after
// real code (or inside a string literal, which never opens the leading comment run) is not.
export function hasTsNoCheck(sourceText) {
  let i = 0
  const n = sourceText.length
  while (i < n) {
    const rest = sourceText.slice(i)
    const blank = /^[ \t]*\r?\n/.exec(rest)
    if (blank) {
      i += blank[0].length
      continue
    }
    if (rest.startsWith('//')) {
      const end = sourceText.indexOf('\n', i)
      const line = end === -1 ? sourceText.slice(i) : sourceText.slice(i, end)
      if (/^\/\/\s*@ts-nocheck\b/.test(line)) {
        return true
      }
      i = end === -1 ? n : end + 1
      continue
    }
    if (rest.startsWith('/*')) {
      const end = sourceText.indexOf('*/', i + 2)
      const block = end === -1 ? sourceText.slice(i) : sourceText.slice(i, end + 2)
      if (/^\/\*\s*@ts-nocheck\b/.test(block)) {
        return true
      }
      i = end === -1 ? n : end + 2
      continue
    }
    break
  }
  return false
}

// Collect every currently tracked file that carries a `@ts-nocheck` header.
export function collectCurrentTsNoCheckFiles(root = process.cwd()) {
  const sources = readTrackedSources(
    root,
    ['*.ts', '*.tsx', '*.mts', '*.cts'],
    (rel) => !SELF_FILES.has(rel)
  )
  return [...sources]
    .filter(([, src]) => hasTsNoCheck(src))
    .map(([rel]) => rel)
    .sort()
}

const RATCHET = {
  name: 'ts-nocheck',
  baselinePath: BASELINE_PATH,
  header: [
    '# Files currently allowed to carry a `@ts-nocheck` header.',
    '# This is a RATCHET: the list may only SHRINK. These exist only because the split',
    '# runtime mixin chain cannot express forward references yet — do NOT add entries to',
    '# get CI green; fix the types instead.',
    '# Regenerate/prune: pnpm check:ts-nocheck-ratchet --prune   (removes stale entries only)'
  ],
  collect: collectCurrentTsNoCheckFiles,
  fix: [
    '`@ts-nocheck` disables ALL type checking for the whole file, not just one line. The',
    'grandfathered entries exist only because the split runtime mixin chain cannot express',
    'forward references yet — that is not a general license to suppress.',
    'Fix it: fix the types instead of suppressing the whole file.'
  ]
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(RATCHET, root, arg)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
