import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pathToFileURL } from 'node:url'

export function parseTimingLog(text) {
  const clean = stripVTControlCharacters(text)
  const unit = {}
  const e2e = {}
  for (const match of clean.matchAll(
    /[✓×❯] ([\w./-]+\.test\.(?:ts|tsx|mjs)) \([^\n]*?\)\s+([\d.]+)ms/g
  )) {
    unit[match[1]] = Number(match[2])
  }
  for (const match of clean.matchAll(
    /[✓✘]\s+\d+ \[electron-headless\] › (tests\/e2e\/[^:]+):\d+:\d+ › .*? \(([\d.]+)(ms|s|m)\)/g
  )) {
    e2e[match[1]] = (e2e[match[1]] ?? 0) + Number(match[2]) * { ms: 1, s: 1000, m: 60000 }[match[3]]
  }
  const summary = clean.match(
    /Duration\s+[\d.]+s \(transform ([\d.]+)s, setup ([\d.]+)s, import ([\d.]+)s, tests [\d.]+s, environment ([\d.]+)s\)/
  )
  return {
    unit,
    e2e,
    overheadMs: summary ? summary.slice(1).reduce((sum, value) => sum + Number(value) * 1000, 0) : 0
  }
}

export function importTimingLogs(directory, unitRun, e2eRun) {
  const baseline = {
    unit: { runId: unitRun, jobIds: [], overheadMs: 0, timings: {} },
    e2e: { runId: e2eRun, jobIds: [], overheadMs: 0, timings: {} }
  }
  for (const file of readdirSync(directory)
    .filter((file) => /^log-\d+\.txt$/.test(file))
    .sort()) {
    const parsed = parseTimingLog(readFileSync(join(directory, file), 'utf8'))
    for (const suite of ['unit', 'e2e']) {
      if (!Object.keys(parsed[suite]).length) {
        continue
      }
      baseline[suite].jobIds.push(file.match(/\d+/)[0])
      for (const [name, duration] of Object.entries(parsed[suite])) {
        if (suite === 'unit' && name in baseline.unit.timings) {
          throw new Error(`Duplicate unit timing: ${name}`)
        }
        baseline[suite].timings[name] = (baseline[suite].timings[name] ?? 0) + duration
      }
    }
    baseline.unit.overheadMs += parsed.overheadMs
  }
  for (const suite of ['unit', 'e2e']) {
    if (!baseline[suite].jobIds.length) {
      throw new Error(`No ${suite} timing evidence`)
    }
    baseline[suite].timings = Object.fromEntries(
      Object.entries(baseline[suite].timings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  }
  baseline.unit.overheadMs = Math.ceil(
    baseline.unit.overheadMs / Object.keys(baseline.unit.timings).length
  )
  return baseline
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, unitRun, e2eRun, output] = process.argv.slice(2)
  if (!directory || !unitRun || !e2eRun || !output) {
    throw new Error('Usage: ci-shard-timing-import.mjs LOG_DIRECTORY UNIT_RUN E2E_RUN OUTPUT')
  }
  writeFileSync(
    output,
    `${JSON.stringify(importTimingLogs(directory, unitRun, e2eRun), null, 2)}\n`
  )
}
