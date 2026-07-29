import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet gate for the oxlint `max-lines` rule.
//
// oxlint already fails any file that exceeds max-lines WITHOUT a suppression, so
// the only way a file grows past the budget is by adding an `eslint/oxlint-disable
// max-lines` comment or a per-file `max-lines` bump in mobile/.oxlintrc.json. This
// check freezes the set of files currently allowed to do that (the baseline) and
// fails CI when a NEW bypass appears — the existing over-limit files are
// grandfathered; new ones must split instead. The baseline may only shrink.

const BASELINE_PATH = 'config/max-lines-baseline.txt'
const MOBILE_CONFIG_PATH = 'mobile/.oxlintrc.json'
// These two files legitimately contain the directive text as data (regex, fixtures),
// so scanning them would self-flag. The ratchet does not police itself.
const SELF_FILES = new Set([
  'config/scripts/check-max-lines-ratchet.mjs',
  'config/scripts/check-max-lines-ratchet.test.mjs'
])

// Default max-lines budgets from .oxlintrc.json (counted lines).
export function defaultLimitForPath(p) {
  if (/\.(test|spec)\.(ts|tsx)$/.test(p)) {
    return 800
  }
  if (p.endsWith('.tsx')) {
    return 400
  }
  if (p.endsWith('.mjs')) {
    return 600
  }
  return 300
}

// True if the source contains an eslint/oxlint disable directive listing `max-lines`
// (block or line, bare or compound, with or without a `-- Why:` reason).
export function hasMaxLinesDisable(sourceText) {
  const re = /(?:eslint|oxlint)-disable(?:-next-line|-line)?\b([^\n]*)/g
  let m
  while ((m = re.exec(sourceText)) !== null) {
    let rules = m[1]
    rules = rules.split('--')[0] // strip the reason
    const close = rules.indexOf('*/')
    if (close !== -1) {
      rules = rules.slice(0, close) // strip block-comment tail
    }
    if (/\bmax-lines\b/.test(rules)) {
      return true
    }
  }
  return false
}

// Per-file `max-lines` bumps in mobile/.oxlintrc.json whose `max` exceeds the
// default for that glob (a lower `max` is stricter, not a bypass).
export function collectMobileBumps(configText) {
  const cfg = JSON.parse(configText)
  const bumps = []
  for (const override of cfg.overrides ?? []) {
    const rule = override.rules?.['max-lines']
    if (!Array.isArray(rule) || typeof rule[1]?.max !== 'number') {
      continue
    }
    for (const glob of override.files ?? []) {
      if (rule[1].max > defaultLimitForPath(glob)) {
        bumps.push(`mobile-config ${glob} max=${rule[1].max}`)
      }
    }
  }
  return bumps
}

// Include mobile ceilings so a per-file override cannot rise under the same glob.
export function parseMobileCeiling(entry) {
  const match = /^mobile-config (.+) max=(\d+)$/.exec(entry)
  if (!match) {
    return null
  }
  return { entry, glob: match[1], max: Number(match[2]) }
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
  const currentMobile = new Map(
    [...cur]
      .map(parseMobileCeiling)
      .filter(Boolean)
      .map((entry) => [entry.glob, entry])
  )
  const baselineMobile = new Map(
    [...base]
      .map(parseMobileCeiling)
      .filter(Boolean)
      .map((entry) => [entry.glob, entry])
  )
  const added = [...cur]
    .filter((entry) => !base.has(entry) && !baselineMobile.has(parseMobileCeiling(entry)?.glob))
    .sort()
  const stale = [...base]
    .filter((entry) => !cur.has(entry) && !currentMobile.has(parseMobileCeiling(entry)?.glob))
    .sort()
  const increased = []
  const lowered = []

  for (const [glob, currentEntry] of currentMobile) {
    const baselineEntry = baselineMobile.get(glob)
    if (!baselineEntry) {
      continue
    }
    if (currentEntry.max > baselineEntry.max) {
      increased.push({ glob, from: baselineEntry.max, to: currentEntry.max })
    } else if (currentEntry.max < baselineEntry.max) {
      lowered.push({ glob, from: baselineEntry.max, to: currentEntry.max })
    }
  }

  return { added, stale, increased, lowered }
}

export function pruneBaseline(current, baseline) {
  const cur = new Set(current)
  const currentMobile = new Map(
    [...cur]
      .map(parseMobileCeiling)
      .filter(Boolean)
      .map((entry) => [entry.glob, entry])
  )

  return [...baseline]
    .flatMap((entry) => {
      const mobileEntry = parseMobileCeiling(entry)
      if (!mobileEntry) {
        return cur.has(entry) ? [entry] : []
      }
      const currentEntry = currentMobile.get(mobileEntry.glob)
      if (!currentEntry) {
        return []
      }
      return currentEntry.max <= mobileEntry.max ? [currentEntry.entry] : [entry]
    })
    .sort()
}

export function planBaselinePrune(current, baseline) {
  const { added, stale, increased, lowered } = diffBaseline(current, baseline)
  return {
    added,
    increased,
    kept: pruneBaseline(current, baseline),
    lowered,
    stale
  }
}

export function formatPruneSummary({ kept, stale, lowered }) {
  const staleLabel = stale.length === 1 ? 'entry' : 'entries'
  const ceilingLabel = lowered.length === 1 ? 'ceiling' : 'ceilings'
  return `Pruned baseline to ${kept.length} entries (removed ${stale.length} stale ${staleLabel}; updated ${lowered.length} lowered mobile ${ceilingLabel}).`
}

// Collect every current suppression entry from the tracked tree.
export function collectCurrentSuppressions(root = process.cwd()) {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], {
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
    if (hasMaxLinesDisable(src)) {
      entries.push(`inline ${rel}`)
    }
  }

  const mobileCfgPath = path.join(root, MOBILE_CONFIG_PATH)
  if (fs.existsSync(mobileCfgPath)) {
    entries.push(...collectMobileBumps(fs.readFileSync(mobileCfgPath, 'utf8')))
  }

  return entries.sort()
}

function printAddedFailure(added, increased) {
  for (const entry of added) {
    console.error(`::error::New max-lines bypass not allowed: ${entry}`)
  }
  for (const { glob, from, to } of increased) {
    console.error(`::error::Mobile max-lines ceiling increased: ${glob} (${from} -> ${to})`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  max-lines ratchet failed — a bypass or mobile ceiling grew.              │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  const violations = added.length + increased.length
  console.error(`  ${violations} max-lines policy violation(s):`)
  console.error('')
  for (const entry of added) {
    const [kind, ...rest] = entry.split(' ')
    const target = rest.join(' ')
    const how =
      kind === 'inline'
        ? 'added an eslint/oxlint-disable max-lines comment'
        : 'added a per-file max-lines bump in mobile/.oxlintrc.json'
    console.error(`    • ${target}\n        ↳ ${how}`)
  }
  for (const { glob, from, to } of increased) {
    console.error(`    • ${glob}\n        ↳ mobile ceiling grew from ${from} to ${to}`)
  }
  console.error('')
  console.error('  Orca caps file size (300 .ts / 400 .tsx / 600 .mjs / 800 test — non-blank,')
  console.error(
    '  non-comment lines). Existing oversized files are grandfathered; NEW ones are not.'
  )
  console.error('')
  console.error('  ✅  Fix it: SPLIT the file into focused modules — do NOT suppress the rule.')
  console.error('      See AGENTS.md → "Lint Rules: Do Not Disable Max Lines".')
  console.error('      Mobile ceilings may only stay the same or decrease.')
  console.error('')
  console.error('  (If you are intentionally, with reviewer sign-off, adding an unavoidable')
  console.error(`   exception, add the exact line(s) above to ${BASELINE_PATH}.)`)
  console.error('')
}

export function printStaleFailure(stale, lowered) {
  for (const entry of stale) {
    console.error(`::error::Stale max-lines baseline entry (prune it): ${entry}`)
  }
  for (const { glob, from, to } of lowered) {
    console.error(`::notice::Mobile max-lines ceiling lowered: ${glob} (${from} -> ${to})`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ⚠️  max-lines baseline needs to shrink.                                      │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  if (stale.length > 0) {
    console.error(`  ${stale.length} stale baseline entr(y/ies) no longer have a suppression.`)
    console.error('  These stale entries must be removed to keep re-adding blocked:')
    console.error('')
    for (const entry of stale) {
      console.error(`    • ${entry}`)
    }
    console.error('')
  }
  if (lowered.length > 0) {
    console.error(`  ${lowered.length} mobile max-lines ceiling(s) decreased.`)
    console.error('  These lowered ceilings must update their baseline values:')
    console.error('')
    for (const { glob, from, to } of lowered) {
      console.error(`    • ${glob}\n        ↳ mobile ceiling dropped from ${from} to ${to}`)
    }
    console.error('')
  }
  console.error(`  ✅  Fix it (one command):  pnpm check:max-lines-ratchet --prune`)
  console.error('')
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing ${BASELINE_PATH}. Generate it with: node config/scripts/check-max-lines-ratchet.mjs --init`
    )
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = collectCurrentSuppressions(root)
  const { added, stale, increased, lowered } = diffBaseline(current, baseline)

  if (added.length > 0 || increased.length > 0) {
    printAddedFailure(added, increased)
    if (stale.length > 0 || lowered.length > 0) {
      console.error(
        `  (Also: ${stale.length + lowered.length} baseline entr(y/ies) can be pruned — see below.)`
      )
      printStaleFailure(stale, lowered)
    }
    return 1
  }
  if (stale.length > 0 || lowered.length > 0) {
    printStaleFailure(stale, lowered)
    return 1
  }
  console.log(
    `max-lines ratchet OK — ${current.length} grandfathered suppression(s), no new bypasses.`
  )
  return 0
}

function writeBaseline(root, entries) {
  const header = [
    '# Files/globs currently allowed to exceed the oxlint `max-lines` budget.',
    '# This is a RATCHET: the list may only SHRINK. Do NOT add entries to get CI green —',
    '# split the oversized file instead (AGENTS.md → "Do Not Disable Max Lines").',
    '# Mobile entries record max=<ceiling>; their ceiling may only decrease.',
    '# Regenerate/prune: pnpm check:max-lines-ratchet --prune   (removes stale entries and lowers ceilings)',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${entries.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    // One-time bootstrap: capture the current suppression set as the baseline.
    const entries = collectCurrentSuppressions(root)
    writeBaseline(root, entries)
    console.log(`Wrote ${BASELINE_PATH} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    // Remove stale entries and record mobile ceiling decreases; never add or raise a bypass.
    const current = collectCurrentSuppressions(root)
    const baseline = parseBaseline(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
    const plan = planBaselinePrune(current, baseline)
    writeBaseline(root, plan.kept)
    console.log(formatPruneSummary(plan))
    if (plan.added.length > 0 || plan.increased.length > 0) {
      console.error(
        `::error::--prune does not add entries or raise mobile ceilings; ${plan.added.length + plan.increased.length} policy violation(s) remain — split those files.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(main(root))
}
