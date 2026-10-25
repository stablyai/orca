import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Baselines shared by the ratchet gates. An entry baseline lists one allowed entry per line; a
// count baseline holds `<count> <path> [# note]` rows. `#` lines and blanks are ignored in both.

/** Tracked files under `pathspecs`, so build output and untracked scratch are never scanned. */
export function listTrackedFiles(root, pathspecs) {
  return execFileSync('git', ['ls-files', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)
}

/** Tracked files with their text; one deleted in the working tree is skipped. */
export function readTrackedSources(root, pathspecs, include = () => true) {
  const sources = new Map()
  for (const rel of listTrackedFiles(root, pathspecs).filter(include)) {
    try {
      sources.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
    } catch {
      // Deleted in the working tree but still tracked.
    }
  }
  return sources
}

export function parseEntryBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** `added`: not in the baseline (fails). `stale`: gone, must be pruned so it cannot come back. */
export function diffEntries(current, baseline) {
  const cur = new Set(current)
  const base = new Set(baseline)
  return {
    added: [...cur].filter((entry) => !base.has(entry)).sort(),
    stale: [...base].filter((entry) => !cur.has(entry)).sort()
  }
}

function writeEntryBaseline(root, ratchet, entries) {
  fs.writeFileSync(
    path.join(root, ratchet.baselinePath),
    `${[...ratchet.header, ''].join('\n')}${entries.join('\n')}\n`
  )
}

/**
 * Gate for an entry ratchet `{ name, baselinePath, header, collect(root), fix }`: a new entry
 * fails with `fix`, a stale one fails until pruned. `--prune` drops stale entries only.
 */
export function runEntryRatchet(ratchet, root, arg) {
  const baselineFile = path.join(root, ratchet.baselinePath)
  const prune = `pnpm check:${ratchet.name}-ratchet --prune`
  if (arg === '--init') {
    const entries = ratchet.collect(root)
    writeEntryBaseline(root, ratchet, entries)
    console.log(`Wrote ${ratchet.baselinePath} with ${entries.length} entries.`)
    return 0
  }
  if (!fs.existsSync(baselineFile)) {
    console.error(`::error::Missing ${ratchet.baselinePath}. Generate it with: --init`)
    return 1
  }
  const baseline = parseEntryBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = ratchet.collect(root)
  const { added, stale } = diffEntries(current, baseline)
  if (arg === '--prune') {
    const kept = baseline.filter((entry) => current.includes(entry)).sort()
    writeEntryBaseline(root, ratchet, kept)
    console.log(
      `Pruned baseline to ${kept.length} entries (removed ${baseline.length - kept.length}).`
    )
    if (added.length > 0) {
      console.error(`::error::--prune does not add entries; ${added.length} new one(s) remain.`)
      return 1
    }
    return 0
  }
  for (const entry of added) {
    console.error(`::error::New ${ratchet.name} entry not allowed: ${entry}`)
  }
  if (added.length > 0) {
    console.error(`\n${ratchet.fix.join('\n')}`)
    console.error(
      `With reviewer sign-off for an unavoidable exception, add the line(s) to ${ratchet.baselinePath}.\n`
    )
  }
  for (const entry of stale) {
    console.error(`::error::Stale ${ratchet.name} baseline entry (prune it): ${entry}`)
  }
  if (stale.length > 0) {
    console.error(`The baseline may only shrink. Fix it: ${prune}`)
  }
  if (added.length + stale.length > 0) {
    return 1
  }
  console.log(`${ratchet.name} ratchet OK — ${current.length} grandfathered entr(y/ies).`)
  return 0
}

export function parseCountBaseline(text) {
  return new Map(
    parseEntryBaseline(text).map((line) => {
      const [count, file] = line.split(/\s+/, 2)
      return [file, Number(count)]
    })
  )
}

/** Trailing `# note` per row, so a pruned baseline keeps why an entry is still allowed. */
export function parseCountNotes(text) {
  const notes = new Map()
  for (const raw of text.split('\n')) {
    const match = /^\s*\d+\s+(\S+)\s+#\s*(.+?)\s*$/.exec(raw)
    if (match) {
      notes.set(match[1], match[2])
    }
  }
  return notes
}

export function formatCountBaseline(counts, header, notes = new Map()) {
  const rows = [...counts]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, count]) =>
      notes.has(file) ? `${count} ${file} # ${notes.get(file)}` : `${count} ${file}`
    )
  return `${[...header, ''].join('\n')}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`
}

/** `grown`: above baseline (fails). `shrunk`: below baseline, must be pruned so it cannot regrow. */
export function diffCounts(current, baseline) {
  const grown = []
  const shrunk = []
  for (const file of new Set([...current.keys(), ...baseline.keys()])) {
    const now = current.get(file) ?? 0
    const allowed = baseline.get(file) ?? 0
    if (now > allowed) {
      grown.push({ file, now, allowed })
    } else if (now < allowed) {
      shrunk.push({ file, now, allowed })
    }
  }
  const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  return { grown: grown.sort(byFile), shrunk: shrunk.sort(byFile) }
}

export function totalCount(counts) {
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

/** Lowers baseline rows to `current` and keeps their notes; growth still has to be fixed in code. */
export function pruneCountBaseline(root, baselinePath, header, current) {
  const file = path.join(root, baselinePath)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const pruned = new Map(
    [...parseCountBaseline(text)].map(([rel, allowed]) => [
      rel,
      Math.min(allowed, current.get(rel) ?? 0)
    ])
  )
  fs.writeFileSync(file, formatCountBaseline(pruned, header, parseCountNotes(text)))
  return totalCount(pruned)
}

/**
 * Gate for a count ratchet `{ name, baselinePath, header, collect(root), fix, unit }`: a file above
 * its baseline fails with `fix`, one below it fails until pruned. `--prune` lowers rows only.
 */
export function runCountRatchet(ratchet, root, arg) {
  const current = ratchet.collect(root)
  if (arg === '--prune') {
    const total = pruneCountBaseline(root, ratchet.baselinePath, ratchet.header, current)
    console.log(`${ratchet.name} baseline pruned to ${total}.`)
    return 0
  }
  const baselineFile = path.join(root, ratchet.baselinePath)
  const baseline = parseCountBaseline(
    fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : ''
  )
  const inScope = ratchet.scope?.(root)
  const keep = (counts) => (inScope ? new Map([...counts].filter(([key]) => inScope(key))) : counts)
  const { grown, shrunk } = diffCounts(keep(current), keep(baseline))
  for (const { file, now, allowed } of grown) {
    console.error(`${file}: ${now} ${ratchet.unit}, baseline allows ${allowed}.`)
  }
  if (grown.length > 0) {
    console.error(ratchet.fix.join('\n'))
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(`${file}: now ${now}, baseline ${allowed}.`)
  }
  if (shrunk.length > 0) {
    console.error(
      `The baseline may only shrink. Fix it: pnpm check:${ratchet.name}-ratchet --prune`
    )
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(`${ratchet.name} ratchet OK — ${totalCount(current)} grandfathered ${ratchet.unit}.`)
  return 0
}
