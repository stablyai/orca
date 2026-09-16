import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

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

export function parseBaseline(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

export function diffBaseline(current, baseline) {
  const cur = new Set(current)
  const base = baseline instanceof Set ? baseline : new Set(baseline)
  const added = [...cur].filter((e) => !base.has(e)).sort()
  const stale = [...base].filter((e) => !cur.has(e)).sort()
  return { added, stale }
}

// Collect every currently tracked file that carries a `@ts-nocheck` header.
export function collectCurrentTsNoCheckFiles(root = process.cwd()) {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SELF_FILES.has(f))

  const entries = []
  for (const rel of tracked) {
    let src
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    if (hasTsNoCheck(src)) {
      entries.push(rel)
    }
  }

  return entries.sort()
}

function printAddedFailure(added) {
  for (const entry of added) {
    console.error(`::error::New @ts-nocheck not allowed: ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  ts-nocheck ratchet failed — a NEW file adds a @ts-nocheck directive.    │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${added.length} file(s) newly add a \`@ts-nocheck\` header:`)
  console.error('')
  for (const entry of added) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error('  `@ts-nocheck` disables ALL type checking for the whole file, not just one line.')
  console.error(
    '  The grandfathered entries exist only because the split runtime mixin chain cannot'
  )
  console.error('  express forward references yet — that is not a general license to suppress.')
  console.error('')
  console.error('  ✅  Fix it: fix the types instead of suppressing the whole file.')
  console.error('')
  console.error('  (If you are intentionally, with reviewer sign-off, adding an unavoidable')
  console.error(`   exception, add the exact line(s) above to ${BASELINE_PATH}.)`)
  console.error('')
}

function printStaleFailure(stale) {
  for (const entry of stale) {
    console.error(`::error::Stale ts-nocheck baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ⚠️  ts-nocheck baseline is out of date — nice work removing a suppression!   │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${stale.length} baseline entr(y/ies) no longer have a @ts-nocheck directive.`)
  console.error(
    '  The baseline may only shrink, so these must be removed to keep re-adding blocked:'
  )
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(`  ✅  Fix it (one command):  pnpm check:ts-nocheck-ratchet --prune`)
  console.error('')
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing ${BASELINE_PATH}. Generate it with: node config/scripts/check-ts-nocheck-ratchet.mjs --init`
    )
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = collectCurrentTsNoCheckFiles(root)
  const { added, stale } = diffBaseline(current, baseline)

  if (added.length > 0) {
    printAddedFailure(added)
    if (stale.length > 0) {
      console.error(
        `  (Also: ${stale.length} stale baseline entr(y/ies) can be pruned — see below.)`
      )
      printStaleFailure(stale)
    }
    return 1
  }
  if (stale.length > 0) {
    printStaleFailure(stale)
    return 1
  }
  console.log(
    `ts-nocheck ratchet OK — ${current.length} grandfathered file(s), no new suppressions.`
  )
  return 0
}

function writeBaseline(root, entries) {
  const header = [
    '# Files currently allowed to carry a `@ts-nocheck` header.',
    '# This is a RATCHET: the list may only SHRINK. These exist only because the split',
    '# runtime mixin chain cannot express forward references yet — do NOT add entries to',
    '# get CI green; fix the types instead.',
    '# Regenerate/prune: pnpm check:ts-nocheck-ratchet --prune   (removes stale entries only)',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${entries.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    // One-time bootstrap: capture the current @ts-nocheck set as the baseline.
    const entries = collectCurrentTsNoCheckFiles(root)
    writeBaseline(root, entries)
    console.log(`Wrote ${BASELINE_PATH} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    // Remove baseline entries whose @ts-nocheck is gone (shrink only; never adds).
    const current = new Set(collectCurrentTsNoCheckFiles(root))
    const baseline = parseBaseline(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
    const kept = [...baseline].filter((e) => current.has(e)).sort()
    const newlyAdded = [...current].filter((e) => !baseline.has(e))
    writeBaseline(root, kept)
    console.log(
      `Pruned baseline to ${kept.length} entries (removed ${baseline.size - kept.length}).`
    )
    if (newlyAdded.length > 0) {
      console.error(
        `::error::--prune does not add entries; ${newlyAdded.length} new suppression(s) remain — fix those files' types.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(main(root))
}
