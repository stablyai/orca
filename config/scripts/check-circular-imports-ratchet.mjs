import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import madge from 'madge'

// Ratchet gate for circular ES module imports under src/renderer/src.
//
// A cyclical import chain (A imports B imports ... imports A) can leave a module's
// binding `undefined` at the point a sibling in the cycle evaluates it, if evaluation
// order puts the read before the write — the exact shape of a real crash this branch
// fixed (store/index.ts <-> repos.ts <-> onboarding-folder-agent-startup.ts, "X is not
// a function"). This codebase has many pre-existing cycles that happen not to hit that
// failure mode (e.g. type-only edges, or edges whose value use is deferred past module
// init) — rewriting all of them is out of scope. This check freezes the set of cycles
// that exist today (the baseline) and fails when a NEW cycle appears; existing cycles
// are grandfathered. The baseline may only shrink.
//
// Detection uses madge, pointed at a checked-in synthetic webpack config so it can
// resolve the renderer's `@/*` alias via enhanced-resolve — madge's own --ts-config /
// tsConfig mode calls into `ts.sys`, which is undefined under this repo's
// typescript@7, so that mode is not usable here (see config/madge-webpack-alias.config.cjs).

const BASELINE_PATH = 'config/circular-imports-baseline.txt'
const SCAN_DIR = 'src/renderer/src'
const WEBPACK_ALIAS_CONFIG = 'config/madge-webpack-alias.config.cjs'

// madge reports every cycle's node paths relative to the exact directory passed to
// madge() (verified empirically: scanning `src/renderer/src` yields e.g. `store/types.ts`
// for that file, and `../../../package.json` for the repo-root package.json). Rewriting
// them relative to SCAN_DIR gives a stable, repo-root-relative, human-readable identity.
export function canonicalizeCycle(relativeToScanDir) {
  const repoRelative = relativeToScanDir.map((p) =>
    path.join(SCAN_DIR, p).split(path.sep).join('/')
  )
  // A cycle can be reported starting from any of its own nodes — rotate to the
  // lexicographically smallest node so the same logical cycle always canonicalizes
  // the same way, regardless of which node madge's traversal happened to start from.
  let minIndex = 0
  for (let i = 1; i < repoRelative.length; i++) {
    if (repoRelative[i] < repoRelative[minIndex]) {
      minIndex = i
    }
  }
  const rotated = [...repoRelative.slice(minIndex), ...repoRelative.slice(0, minIndex)]
  return rotated.join(' > ')
}

export async function collectCurrentCycles(root = process.cwd()) {
  const result = await madge(path.join(root, SCAN_DIR), {
    fileExtensions: ['ts', 'tsx'],
    webpackConfig: path.join(root, WEBPACK_ALIAS_CONFIG)
  })
  const cycles = result.circular()
  return [...new Set(cycles.map(canonicalizeCycle))].sort()
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

function printAddedFailure(added) {
  for (const entry of added) {
    console.error(`::error::New circular import not allowed: ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  circular-imports ratchet failed — a NEW import cycle was introduced.     │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${added.length} new circular import chain(s) under ${SCAN_DIR}:`)
  console.error('')
  for (const entry of added) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(
    '  A cycle can leave a module binding undefined at the point a sibling module in the'
  )
  console.error(
    '  cycle evaluates it, if evaluation order puts the read before the write — this is a'
  )
  console.error('  real crash class this codebase has hit before, not a style nitpick.')
  console.error('')
  console.error(
    '  ✅  Fix it: break the cycle — usually a lazy `await import()` at the point of use'
  )
  console.error('      (see repos.ts -> onboarding-folder-agent-startup.ts for a fixed example),')
  console.error('      or move the shared piece both sides depend on into a third module.')
  console.error('')
  console.error(
    `  (If this cycle is unavoidable and reviewed as safe, add the exact line(s) above to`
  )
  console.error(`   ${BASELINE_PATH}.)`)
  console.error('')
}

function printStaleFailure(stale) {
  for (const entry of stale) {
    console.error(`::error::Stale circular-imports baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ⚠️  circular-imports baseline is out of date — nice work breaking a cycle!   │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${stale.length} baseline entr(y/ies) no longer form a cycle.`)
  console.error(
    '  The baseline may only shrink, so these must be removed to keep re-adding blocked:'
  )
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(`  ✅  Fix it (one command):  pnpm check:circular-imports-ratchet --prune`)
  console.error('')
}

export async function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing ${BASELINE_PATH}. Generate it with: node config/scripts/check-circular-imports-ratchet.mjs --init`
    )
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = await collectCurrentCycles(root)
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
    `circular-imports ratchet OK — ${current.length} grandfathered cycle(s), no new ones.`
  )
  return 0
}

function writeBaseline(root, entries) {
  const header = [
    `# Circular import chains currently existing under ${SCAN_DIR}.`,
    '# This is a RATCHET: the list may only SHRINK. Do NOT add entries to get CI green —',
    '# break the new cycle instead (usually a lazy `await import()` at the point of use).',
    '# Regenerate/prune: pnpm check:circular-imports-ratchet --prune   (removes stale entries only)',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${entries.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    const entries = await collectCurrentCycles(root)
    writeBaseline(root, entries)
    console.log(`Wrote ${BASELINE_PATH} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    const current = new Set(await collectCurrentCycles(root))
    const baseline = parseBaseline(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
    const kept = [...baseline].filter((e) => current.has(e)).sort()
    const newlyAdded = [...current].filter((e) => !baseline.has(e))
    writeBaseline(root, kept)
    console.log(
      `Pruned baseline to ${kept.length} entries (removed ${baseline.size - kept.length}).`
    )
    if (newlyAdded.length > 0) {
      console.error(
        `::error::--prune does not add entries; ${newlyAdded.length} new cycle(s) remain — break those.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(await main(root))
}
