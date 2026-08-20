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
//
// Grandfathered is not a blank cheque: each baseline entry also carries a frozen
// line budget (`max=<n>`), so an exempt file may not keep growing. Counting only
// files let orca-runtime.ts go 4.8k -> 41k lines while this gate stayed green.

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

// Lines that count against the oxlint budget: `skipBlankLines` + `skipComments`.
// A deliberate heuristic, not a TS parse — it tracks block comments, template
// literals, and quoted strings so `"https://x"` is code and `* bullet` is not.
// Exactness versus oxlint does not matter: the baseline is written by this same
// counter, so the frozen number and the measured number always agree.
export function countNonBlankNonCommentLines(sourceText) {
  let inBlockComment = false
  let inTemplate = false
  let counted = 0

  for (const line of sourceText.split('\n')) {
    let hasCode = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const next = line[i + 1]

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false
          i++
        }
        continue
      }

      if (inTemplate) {
        hasCode = true
        if (char === '\\') {
          i++
        } else if (char === '`') {
          inTemplate = false
        }
        continue
      }

      if (char === '/' && next === '*') {
        inBlockComment = true
        i++
        continue
      }
      if (char === '/' && next === '/') {
        break // rest of the line is a comment
      }
      if (char === '`') {
        inTemplate = true
        hasCode = true
        continue
      }
      if (char === '"' || char === "'") {
        hasCode = true
        const quote = char
        i++
        while (i < line.length && line[i] !== quote) {
          i += line[i] === '\\' ? 2 : 1
        }
        continue
      }
      if (!/\s/.test(char)) {
        hasCode = true
      }
    }

    if (hasCode) {
      counted++
    }
  }

  return counted
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
// The frozen number here is the declared `max`, not a line count: a glob names no
// single file, and raising the bump is how one of these grows.
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
        bumps.push({ key: `mobile-config ${glob}`, count: rule[1].max })
      }
    }
  }
  return bumps
}

// Baseline rows are `<kind> <target>` with an optional ` max=<n>` line budget.
// Rows without a budget are legacy and stay unenforced until the next --prune.
export function parseBaseline(text) {
  const entries = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const match = /^(.*?)\s+max=(\d+)$/.exec(line)
    if (match) {
      entries.set(match[1].trim(), Number(match[2]))
    } else {
      entries.set(line, null)
    }
  }
  return entries
}

function formatBaselineRow(key, budget) {
  return budget === null ? key : `${key} max=${budget}`
}

// current: [{ key, count }] where count is the number that may not increase —
// measured lines for an inline suppression, the declared `max` for a mobile bump.
export function diffBaseline(current, baseline) {
  const counts = new Map(current.map((e) => [e.key, e.count]))
  const base = baseline instanceof Map ? baseline : new Map([...baseline].map((k) => [k, null]))

  const added = [...counts.keys()].filter((k) => !base.has(k)).sort()
  const stale = [...base.keys()].filter((k) => !counts.has(k)).sort()

  const grown = []
  const shrunk = []
  for (const [key, budget] of base) {
    const count = counts.get(key)
    if (budget === null || count === null || count === undefined) {
      continue
    }
    if (count > budget) {
      grown.push({ key, budget, count })
    } else if (count < budget) {
      shrunk.push({ key, budget, count })
    }
  }
  grown.sort((a, b) => b.count - b.budget - (a.count - a.budget))
  shrunk.sort((a, b) => a.key.localeCompare(b.key))

  return { added, stale, grown, shrunk }
}

// Collect every current suppression entry, with its counted-line total.
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
      entries.push({ key: `inline ${rel}`, count: countNonBlankNonCommentLines(src) })
    }
  }

  const mobileCfgPath = path.join(root, MOBILE_CONFIG_PATH)
  if (fs.existsSync(mobileCfgPath)) {
    entries.push(...collectMobileBumps(fs.readFileSync(mobileCfgPath, 'utf8')))
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

function printAddedFailure(added) {
  for (const entry of added) {
    console.error(`::error::New max-lines bypass not allowed: ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  max-lines ratchet failed — a NEW file is trying to exceed the line cap.  │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${added.length} file(s)/glob(s) newly bypass the oxlint \`max-lines\` rule:`)
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
  console.error('')
  console.error('  Orca caps file size (300 .ts / 400 .tsx / 600 .mjs / 800 test — non-blank,')
  console.error(
    '  non-comment lines). Existing oversized files are grandfathered; NEW ones are not.'
  )
  console.error('')
  console.error('  ✅  Fix it: SPLIT the file into focused modules — do NOT suppress the rule.')
  console.error('      See AGENTS.md → "Lint Rules: Do Not Disable Max Lines".')
  console.error('')
  console.error('  (If you are intentionally, with reviewer sign-off, adding an unavoidable')
  console.error(`   exception, add the exact line(s) above to ${BASELINE_PATH}.)`)
  console.error('')
}

// Inline entries freeze measured lines; mobile-config entries freeze the declared cap.
function describeBudgetChange(key, budget, count) {
  const [kind, ...rest] = key.split(' ')
  const unit = kind === 'inline' ? 'counted lines' : 'declared max-lines cap'
  const delta = count > budget ? `+${count - budget}` : `${count - budget}`
  return `    • ${rest.join(' ')}\n        ↳ ${budget} → ${count} ${unit} (${delta})`
}

function printGrownFailure(grown) {
  for (const { key, budget, count } of grown) {
    console.error(
      `::error::Grandfathered entry grew past its frozen budget: ${key} ${count}>${budget}`
    )
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  max-lines ratchet failed — a grandfathered file GREW.                    │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${grown.length} already-oversized entr(y/ies) got bigger:`)
  console.error('')
  for (const { key, budget, count } of grown) {
    console.error(describeBudgetChange(key, budget, count))
  }
  console.error('')
  console.error('  These files are exempt from the cap only at the size they were already at.')
  console.error('  The exemption is a freeze, not a licence to keep growing.')
  console.error('')
  console.error('  ✅  Fix it: put the new code in a NEW focused module beside the big file,')
  console.error('      or split enough out of it to land net-neutral. See AGENTS.md →')
  console.error('      "Lint Rules: Do Not Disable Max Lines".')
  console.error('')
}

function printStaleFailure(stale) {
  for (const entry of stale) {
    console.error(`::error::Stale max-lines baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ⚠️  max-lines baseline is out of date — nice work removing a bypass!         │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${stale.length} baseline entr(y/ies) no longer have a max-lines suppression.`)
  console.error(
    '  The baseline may only shrink, so these must be removed to keep re-adding blocked:'
  )
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(`  ✅  Fix it (one command):  pnpm check:max-lines-ratchet --prune`)
  console.error('')
}

function printShrunkFailure(shrunk) {
  for (const { key, budget, count } of shrunk) {
    console.error(`::error::Baseline budget is stale (relock it): ${key} ${count}<${budget}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ⚠️  max-lines budgets are out of date — nice work shrinking these files!     │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${shrunk.length} entr(y/ies) are now smaller than their frozen budget.`)
  console.error('  Re-freeze at the new low so the space you just reclaimed cannot be refilled:')
  console.error('')
  for (const { key, budget, count } of shrunk) {
    console.error(describeBudgetChange(key, budget, count))
  }
  console.error('')
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
  const { added, stale, grown, shrunk } = diffBaseline(current, baseline)

  // Hard failures first: a new bypass, or an exempt file that grew.
  if (added.length > 0 || grown.length > 0) {
    if (added.length > 0) {
      printAddedFailure(added)
    }
    if (grown.length > 0) {
      printGrownFailure(grown)
    }
    if (stale.length > 0) {
      printStaleFailure(stale)
    }
    if (shrunk.length > 0) {
      printShrunkFailure(shrunk)
    }
    return 1
  }
  if (stale.length > 0 || shrunk.length > 0) {
    if (stale.length > 0) {
      printStaleFailure(stale)
    }
    if (shrunk.length > 0) {
      printShrunkFailure(shrunk)
    }
    return 1
  }

  const budgeted = [...baseline.values()].filter((b) => b !== null).length
  console.log(
    `max-lines ratchet OK — ${current.length} grandfathered suppression(s) (${budgeted} line-budgeted), no new bypasses and no growth.`
  )
  return 0
}

function writeBaseline(root, rows) {
  const header = [
    '# Files/globs currently allowed to exceed the oxlint `max-lines` budget.',
    '# This is a RATCHET: the list may only SHRINK. Do NOT add entries to get CI green —',
    '# split the oversized file instead (AGENTS.md → "Do Not Disable Max Lines").',
    '#',
    '# `max=<n>` freezes the entry at its current size: counted lines (non-blank,',
    '# non-comment) for an inline suppression, the declared cap for a mobile-config',
    '# bump. Being on this list exempts a file from the rule at the size it already',
    '# had — it may not grow past it. Budgets may only go DOWN.',
    '#',
    '# Regenerate/prune: pnpm check:max-lines-ratchet --prune   (drops stale entries,',
    '# re-freezes budgets that shrank; never adds an entry or raises a budget)',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${rows.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    // One-time bootstrap: capture the current suppression set as the baseline.
    const entries = collectCurrentSuppressions(root)
    writeBaseline(
      root,
      entries.map((e) => formatBaselineRow(e.key, e.count))
    )
    console.log(`Wrote ${BASELINE_PATH} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    // Shrink only: drop entries whose suppression is gone, lower budgets that
    // shrank, and never add an entry or raise a budget.
    const current = collectCurrentSuppressions(root)
    const counts = new Map(current.map((e) => [e.key, e.count]))
    const baseline = parseBaseline(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'))

    const kept = []
    let relocked = 0
    for (const [key, budget] of [...baseline].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!counts.has(key)) {
        continue
      }
      const count = counts.get(key)
      // A legacy row (budget null) adopts today's count; an existing budget only drops.
      let next = budget
      if (count !== null && (budget === null || count < budget)) {
        next = count
        relocked++
      }
      kept.push(formatBaselineRow(key, next))
    }

    const newlyAdded = [...counts.keys()].filter((k) => !baseline.has(k))
    writeBaseline(root, kept)
    console.log(
      `Pruned baseline to ${kept.length} entries (removed ${baseline.size - kept.length}, re-locked ${relocked} budget(s)).`
    )
    if (newlyAdded.length > 0) {
      console.error(
        `::error::--prune does not add entries; ${newlyAdded.length} new bypass(es) remain — split those files.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(main(root))
}
