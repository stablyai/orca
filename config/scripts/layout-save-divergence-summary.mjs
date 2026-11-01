// Counts a layout-owner run's save-divergence reports (ORCA_LAYOUT_SAVE_DIVERGENCE_LOG) by kind
// and by the spec that was running when each was written.
// Usage: node layout-save-divergence-summary.mjs <divergence.jsonl> <summary.json> [playwright.json...]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
// Saves land a little after the action that caused them, sometimes after the test ends.
const AFTER_END_MS = 15_000
const BEFORE_START_MS = 2_000

/** A report path with its record id (a uuid or a file path) dropped: `group <id> changed: tabOrder`. */
export function divergenceKind(path) {
  const named =
    /^(editor view|pane tree|group|tab|file|browser|leaf|terminal) (.+?) (added|removed|changed: .*|tab-bar entry removed|kept over .*)$/s.exec(
      path
    )
  const kind = named ? `${named[1]} <id> ${named[3]}` : path.replace(/^\d+ /, '<n> ')
  return kind.replace(UUID, '<id>')
}

/** Every test attempt's time span, from Playwright JSON reports. */
export function testSpans(reports) {
  const spans = []
  const visit = (suite, file) => {
    const suiteFile = suite.file ?? file
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const start = Date.parse(result.startTime)
          if (Number.isFinite(start)) {
            spans.push({
              // The title too: a loop declares many tests on one line.
              spec: `${spec.file ?? suiteFile}:${spec.line} ${spec.title}`,
              start,
              end: start + (result.duration ?? 0)
            })
          }
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, suiteFile)
    }
  }
  for (const report of reports) {
    for (const suite of report.suites ?? []) {
      visit(suite)
    }
  }
  return spans.sort((left, right) => left.start - right.start)
}

function specAt(at, spans) {
  const inside = spans.findLast((span) => span.start <= at && at <= span.end)
  if (inside) {
    return inside.spec
  }
  const near = spans.findLast((span) => span.end < at && at - span.end <= AFTER_END_MS)
  const next = spans.find((span) => span.start > at && span.start - at <= BEFORE_START_MS)
  return (near ?? next)?.spec ?? 'unattributed'
}

const increment = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1
}

export function summarizeDivergence(lines, reports) {
  const spans = testSpans(reports)
  const summary = {
    reports: 0,
    paths: 0,
    unreadable: 0,
    byKind: {},
    bySpec: {},
    bySpecAndKind: {}
  }
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let report
    try {
      report = JSON.parse(line)
    } catch {
      // A line cut short by a killed app.
      summary.unreadable++
      continue
    }
    const spec = specAt(report.at, spans)
    summary.reports++
    increment(summary.bySpec, spec)
    for (const path of report.paths ?? []) {
      const kind = divergenceKind(path)
      summary.paths++
      increment(summary.byKind, kind)
      summary.bySpecAndKind[spec] ??= {}
      increment(summary.bySpecAndKind[spec], kind)
    }
  }
  return summary
}

export function divergenceMarkdown(summary, title) {
  const rows = (counts) =>
    Object.entries(counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key, count]) => `| ${count} | \`${key.replaceAll('|', '\\|')}\` |`)
  const lines = [
    `### ${title}`,
    '',
    `${summary.reports} reports, ${summary.paths} differences, ${summary.unreadable} unreadable lines.`,
    ''
  ]
  if (summary.reports === 0) {
    return `${lines.join('\n')}\n`
  }
  lines.push('| Count | Kind |', '| ---: | --- |', ...rows(summary.byKind), '')
  for (const [spec, kinds] of Object.entries(summary.bySpecAndKind).sort()) {
    lines.push(`<details><summary>${spec}: ${summary.bySpec[spec]} reports</summary>`, '')
    lines.push('| Count | Kind |', '| ---: | --- |', ...rows(kinds), '', '</details>', '')
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [logPath, summaryPath, ...reportPaths] = process.argv.slice(2)
  const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : []
  const reports = reportPaths
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, 'utf8'))]
      } catch {
        // A report cut short by a killed run: its divergences count as unattributed.
        return []
      }
    })
  const summary = summarizeDivergence(lines, reports)
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  const markdown = divergenceMarkdown(summary, `Layout save divergence: ${basename(logPath)}`)
  process.stdout.write(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  }
}
