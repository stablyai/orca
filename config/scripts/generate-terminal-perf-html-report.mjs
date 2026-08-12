import { mkdirSync, writeFileSync } from 'node:fs'
import {
  budgetFailures,
  collectTerminalPerfRows,
  compareScenarios,
  escapeHtml,
  formatLargeValue,
  formatMs,
  readJsonReport,
  scenarioTitle
} from './terminal-perf-report-rows.mjs'
import { basename, dirname } from 'node:path'

const DEFAULT_OUTPUT_PATH = 'test-results/terminal-perf-impact-report.html'

// Why: every tracked metric is lower-is-better, so delta coloring and the
// regression table share one direction rule.
const MS_METRICS = [
  { key: 'medianMs', label: 'Typing median', chart: true },
  { key: 'worstMs', label: 'Typing worst', chart: true },
  { key: 'scrollMs', label: 'Active scroll', chart: true },
  { key: 'restoreMs', label: 'Restore', chart: true },
  { key: 'revisitMs', label: 'Revisit marker', chart: true },
  { key: 'maxTimerDriftMs', label: 'Timer drift', chart: false }
]

const COUNT_METRICS = [
  { key: 'rendererPeakQueuedChars', label: 'Renderer peak queued chars' },
  { key: 'mainPeakInFlightChars', label: 'Main in-flight chars' },
  { key: 'mainPeakPendingChars', label: 'Main pending chars' },
  { key: 'hiddenSkippedChars', label: 'Hidden skipped chars' },
  { key: 'rendererDroppedBacklogs', label: 'Renderer dropped backlogs' },
  // Why: parked-memory scenarios are table-only — heap/view counts have no
  // ms trend story, so they stay out of the charts.
  { key: 'heapUsedMB', label: 'Renderer JS heap (MB)' },
  { key: 'liveTerminals', label: 'Live xterm instances' },
  { key: 'livePaneManagers', label: 'Live pane managers' }
]

const SERIES_COLORS = {
  medianMs: '#2563eb',
  worstMs: '#dc2626',
  scrollMs: '#d97706',
  restoreMs: '#7c3aed',
  revisitMs: '#0d9488'
}

const LABELED_INPUT_RE = /^([\w .#@()+-]+)=(.+)$/

export function parseHtmlReportArgs(argv, env = process.env) {
  const args = [...argv]
  if (args[0] === '--') {
    args.shift()
  }

  const inputs = []
  let outputPath = env.ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH || DEFAULT_OUTPUT_PATH
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output' || arg === '-o') {
      const next = args[index + 1]
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a path`)
      }
      outputPath = next
      index += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length)
      continue
    }
    const labeled = arg.match(LABELED_INPUT_RE)
    if (labeled) {
      inputs.push({ label: labeled[1], path: labeled[2] })
    } else {
      inputs.push({ label: basename(arg).replace(/\.json$/i, ''), path: arg })
    }
  }

  if (inputs.length === 0) {
    throw new Error(
      'Usage: node config/scripts/generate-terminal-perf-html-report.mjs [label=]<playwright-json>... --output <report.html>'
    )
  }
  return { inputs, outputPath }
}

// ── Trend data ────────────────────────────────────────────────────────────

function buildMatrix(revisions) {
  const scenarios = new Map()
  for (const revision of revisions) {
    for (const row of revision.rows) {
      if (!scenarios.has(row.scenario)) {
        scenarios.set(row.scenario, new Map())
      }
      scenarios.get(row.scenario).set(revision.label, row)
    }
  }
  const orderedScenarios = [...scenarios.keys()].sort(compareScenarios)
  return { scenarios, orderedScenarios }
}

function niceCeil(value) {
  if (value <= 0) {
    return 1
  }
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) {
      return step * magnitude
    }
  }
  return 10 * magnitude
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderTrendChart({ scenario, byRevision, revisions, title }) {
  const metrics = MS_METRICS.filter(
    (metric) =>
      metric.chart &&
      revisions.some((revision) => byRevision.get(revision.label)?.[metric.key] != null)
  )
  if (metrics.length === 0) {
    return ''
  }
  const width = 560
  const height = 230
  const pad = { left: 52, right: 14, top: 30, bottom: 38 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const maxValue = Math.max(
    1,
    ...metrics.flatMap((metric) =>
      revisions.map((revision) => byRevision.get(revision.label)?.[metric.key] ?? 0)
    )
  )
  const yMax = niceCeil(maxValue * 1.15)
  const xFor = (index) =>
    pad.left + (revisions.length === 1 ? plotW / 2 : (plotW * index) / (revisions.length - 1))
  const yFor = (value) => pad.top + plotH - (plotH * value) / yMax

  const parts = []
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" class="trend-chart">`
  )
  parts.push(`<text x="${pad.left}" y="16" class="chart-title">${escapeHtml(title)}</text>`)
  // Horizontal gridlines + y labels
  const ticks = 4
  for (let tick = 0; tick <= ticks; tick += 1) {
    const value = (yMax * tick) / ticks
    const y = yFor(value)
    parts.push(
      `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="gridline"/>`
    )
    parts.push(
      `<text x="${pad.left - 6}" y="${y + 3}" class="axis-label" text-anchor="end">${value % 1 === 0 ? value : value.toFixed(1)}</text>`
    )
  }
  // X labels
  revisions.forEach((revision, index) => {
    parts.push(
      `<text x="${xFor(index)}" y="${height - pad.bottom + 16}" class="axis-label" text-anchor="middle">${escapeHtml(revision.label)}</text>`
    )
  })
  // Series
  for (const metric of metrics) {
    const color = SERIES_COLORS[metric.key] ?? '#475569'
    const points = revisions
      .map((revision, index) => ({ index, value: byRevision.get(revision.label)?.[metric.key] }))
      .filter((point) => point.value != null)
    if (points.length === 0) {
      continue
    }
    const path = points
      .map(
        (point, order) =>
          `${order === 0 ? 'M' : 'L'}${xFor(point.index).toFixed(1)},${yFor(point.value).toFixed(1)}`
      )
      .join(' ')
    parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`)
    for (const point of points) {
      const x = xFor(point.index)
      const y = yFor(point.value)
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`)
      parts.push(
        `<text x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" class="point-label" text-anchor="middle" fill="${color}">${point.value % 1 === 0 ? point.value : point.value.toFixed(1)}</text>`
      )
    }
  }
  parts.push('</svg>')

  const legend = metrics
    .map((metric) => {
      const color = SERIES_COLORS[metric.key] ?? '#475569'
      return `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(metric.label)}</span>`
    })
    .join('')
  return `<figure class="chart-card" data-scenario="${escapeHtml(scenario)}">${parts.join('')}<figcaption class="legend">${legend} <span class="legend-unit">ms — lower is better</span></figcaption></figure>`
}

function deltaCell(baseline, latest, { lowerIsBetter = true, zeroBudget = false } = {}) {
  if (baseline == null || latest == null) {
    return '<td class="delta">—</td>'
  }
  const diff = latest - baseline
  const pct = baseline === 0 ? null : (diff / baseline) * 100
  let cls = 'neutral'
  if (zeroBudget) {
    cls = latest > 0 ? 'worse' : 'better'
  } else if (pct != null && Math.abs(pct) >= 5) {
    cls = diff < 0 === lowerIsBetter ? 'better' : 'worse'
  } else if (baseline === 0 && diff !== 0) {
    cls = diff < 0 === lowerIsBetter ? 'better' : 'worse'
  }
  const pctLabel =
    pct == null ? (diff === 0 ? '±0%' : 'new') : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
  const diffLabel = `${diff >= 0 ? '+' : ''}${Math.abs(diff) >= 100 ? Math.round(diff) : diff.toFixed(1)}`
  return `<td class="delta ${cls}">${escapeHtml(pctLabel)} <span class="delta-abs">(${escapeHtml(diffLabel)})</span></td>`
}

function renderScenarioTable({ scenario, byRevision, revisions, title }) {
  const metricRows = []
  const allMetrics = [...MS_METRICS, ...COUNT_METRICS]
  for (const metric of allMetrics) {
    const values = revisions.map((revision) => byRevision.get(revision.label)?.[metric.key])
    if (values.every((value) => value == null)) {
      continue
    }
    const isMs = MS_METRICS.includes(metric)
    const format = isMs ? formatMs : formatLargeValue
    const cells = values
      .map((value) => `<td>${value == null ? '—' : escapeHtml(format(value))}</td>`)
      .join('')
    const baseline = values.find((value) => value != null)
    const latest = values.toReversed().find((value) => value != null)
    metricRows.push(
      `<tr><th scope="row">${escapeHtml(metric.label)}</th>${cells}${deltaCell(baseline, latest, {
        zeroBudget: metric.key === 'rendererDroppedBacklogs'
      })}</tr>`
    )
  }
  if (metricRows.length === 0) {
    return ''
  }
  const headers = revisions.map((revision) => `<th>${escapeHtml(revision.label)}</th>`).join('')
  return `<section class="scenario-block">
<h3>${escapeHtml(title)} <span class="scenario-id">${escapeHtml(scenario)}</span></h3>
<table class="trend-table">
<thead><tr><th>Metric</th>${headers}<th>Δ first → last</th></tr></thead>
<tbody>${metricRows.join('')}</tbody>
</table>
</section>`
}

function renderHeadline(revisions, matrix) {
  if (revisions.length < 2) {
    return ''
  }
  const first = revisions[0]
  const last = revisions.at(-1)
  const cards = []
  for (const scenario of matrix.orderedScenarios) {
    const byRevision = matrix.scenarios.get(scenario)
    const baseRow = byRevision.get(first.label)
    const lastRow = byRevision.get(last.label)
    if (!baseRow || !lastRow || baseRow.medianMs == null || lastRow.medianMs == null) {
      continue
    }
    const diff = lastRow.medianMs - baseRow.medianMs
    const pct = baseRow.medianMs === 0 ? 0 : (diff / baseRow.medianMs) * 100
    const cls = Math.abs(pct) < 5 ? 'neutral' : diff < 0 ? 'better' : 'worse'
    cards.push(`<div class="card ${cls}">
<div class="card-title">${escapeHtml(scenarioTitle(scenario, lastRow))}</div>
<div class="card-value">${escapeHtml(formatMs(baseRow.medianMs))} → ${escapeHtml(formatMs(lastRow.medianMs))}</div>
<div class="card-sub">typing median, ${escapeHtml(first.label)} → ${escapeHtml(last.label)} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)</div>
</div>`)
  }
  if (cards.length === 0) {
    return ''
  }
  return `<section><h2>Baseline vs latest</h2><div class="cards">${cards.join('')}</div></section>`
}

function renderBudgets(latestRevision) {
  const failures = []
  for (const row of latestRevision.rows) {
    for (const failure of budgetFailures(row)) {
      failures.push(`${row.scenario}: ${failure}`)
    }
  }
  const status =
    failures.length === 0 ? '<span class="pass">Pass</span>' : '<span class="fail">Fail</span>'
  const failureList =
    failures.length === 0
      ? ''
      : `<ul>${failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}</ul>`
  return `<section><h2>Budget status — ${escapeHtml(latestRevision.label)}</h2>
<p>${latestRevision.rows.length} scenario rows checked: ${status}</p>${failureList}</section>`
}

function renderInputsMeta(revisions) {
  const items = revisions
    .map((revision) => {
      const stats = revision.stats
      const statsLabel = stats
        ? ` — ${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ${stats.flaky ?? 0} flaky`
        : ''
      const failNote =
        stats && stats.unexpected > 0
          ? ' <span class="meta-warn">(failed assertions at this revision; metrics still recorded)</span>'
          : ''
      return `<li><strong>${escapeHtml(revision.label)}</strong> — ${revision.rows.length} scenario rows (${escapeHtml(revision.path)})${escapeHtml(statsLabel)}${failNote}</li>`
    })
    .join('')
  return `<ol class="inputs">${items}</ol>`
}

function renderRawDetails(revisions) {
  return revisions
    .map((revision) => {
      const rows = revision.rows
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.scenario)}</td><td>${row.panes ?? '—'}</td><td>${escapeHtml(formatMs(row.medianMs))}</td><td>${escapeHtml(formatMs(row.worstMs))}</td><td>${escapeHtml(formatMs(row.scrollMs))}</td><td>${escapeHtml(formatMs(row.restoreMs))}</td><td>${escapeHtml(formatMs(row.revisitMs))}</td><td>${escapeHtml(formatLargeValue(row.rendererPeakQueuedChars))}</td><td>${escapeHtml(formatLargeValue(row.hiddenSkippedChars))}</td><td>${row.rendererDroppedBacklogs ?? '—'}</td></tr>`
        )
        .join('')
      return `<details><summary>Raw rows — ${escapeHtml(revision.label)}</summary>
<table class="trend-table">
<thead><tr><th>Scenario</th><th>Panes</th><th>Median</th><th>Worst</th><th>Scroll</th><th>Restore</th><th>Revisit</th><th>Renderer peak</th><th>Hidden skipped</th><th>Drops</th></tr></thead>
<tbody>${rows}</tbody></table></details>`
    })
    .join('')
}

const PAGE_CSS = `
:root { color-scheme: light; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 24px auto; max-width: 1240px; padding: 0 16px; color: #0f172a; background: #f8fafc; }
h1 { font-size: 24px; margin-bottom: 4px; }
h2 { font-size: 18px; margin: 28px 0 10px; }
h3 { font-size: 15px; margin: 18px 0 6px; }
.meta { color: #64748b; font-size: 13px; }
.inputs { font-size: 13px; color: #334155; padding-left: 20px; }
.meta-warn { color: #b45309; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.card { background: #fff; border: 1px solid #e2e8f0; border-left-width: 4px; border-radius: 8px; padding: 10px 12px; }
.card.better { border-left-color: #16a34a; }
.card.worse { border-left-color: #dc2626; }
.card.neutral { border-left-color: #94a3b8; }
.card-title { font-size: 12px; color: #64748b; }
.card-value { font-size: 18px; font-weight: 600; margin: 2px 0; }
.card-sub { font-size: 11px; color: #94a3b8; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(560px, 1fr)); gap: 14px; }
.chart-card { margin: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
.trend-chart { width: 100%; height: auto; }
.chart-title { font-size: 13px; font-weight: 600; fill: #0f172a; }
.gridline { stroke: #e2e8f0; stroke-width: 1; }
.axis-label { font-size: 10px; fill: #64748b; }
.point-label { font-size: 10px; font-weight: 600; }
.legend { font-size: 11px; color: #475569; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.legend-unit { color: #94a3b8; margin-left: auto; }
.scenario-block { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
.scenario-id { font-size: 11px; color: #94a3b8; font-weight: 400; margin-left: 6px; }
table.trend-table { border-collapse: collapse; width: 100%; font-size: 12px; }
table.trend-table th, table.trend-table td { border-bottom: 1px solid #e2e8f0; padding: 5px 8px; text-align: right; white-space: nowrap; }
table.trend-table th:first-child, table.trend-table td:first-child { text-align: left; }
table.trend-table thead th { color: #475569; font-weight: 600; background: #f1f5f9; }
td.delta.better { color: #15803d; font-weight: 600; }
td.delta.worse { color: #b91c1c; font-weight: 600; }
td.delta.neutral { color: #64748b; }
.delta-abs { font-weight: 400; color: #94a3b8; }
.pass { color: #15803d; font-weight: 700; }
.fail { color: #b91c1c; font-weight: 700; }
details { margin: 8px 0; }
summary { cursor: pointer; font-size: 13px; color: #334155; }
`

function renderHtml({ generatedAt, revisions }) {
  const matrix = buildMatrix(revisions)
  const charts =
    revisions.length >= 2
      ? matrix.orderedScenarios
          .map((scenario) => {
            const byRevision = matrix.scenarios.get(scenario)
            const anyRow = [...byRevision.values()][0]
            return renderTrendChart({
              scenario,
              byRevision,
              revisions,
              title: scenarioTitle(scenario, anyRow)
            })
          })
          .filter(Boolean)
          .join('')
      : ''
  const tables = matrix.orderedScenarios
    .map((scenario) => {
      const byRevision = matrix.scenarios.get(scenario)
      const anyRow = [...byRevision.values()][0]
      return renderScenarioTable({
        scenario,
        byRevision,
        revisions,
        title: scenarioTitle(scenario, anyRow)
      })
    })
    .filter(Boolean)
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Terminal Performance Over Time</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Terminal Performance Over Time</h1>
<p class="meta">Generated ${escapeHtml(generatedAt)} from ${revisions.length} benchmark run(s), ordered oldest (baseline) to newest. All metrics: lower is better.</p>
${renderInputsMeta(revisions)}
${renderHeadline(revisions, matrix)}
${charts ? `<section><h2>Trends across revisions</h2><div class="charts">${charts}</div></section>` : ''}
<section><h2>Metric detail by scenario</h2>${tables}</section>
${renderBudgets(revisions.at(-1))}
<section><h2>Raw data</h2>${renderRawDetails(revisions)}</section>
</body>
</html>
`
}

export function generateTerminalPerfHtmlReport({
  inputs,
  inputPaths,
  outputPath,
  now = new Date()
}) {
  // Why: older callers (the scale report gate) pass bare inputPaths.
  const resolvedInputs =
    inputs ??
    (inputPaths ?? []).map((path) => ({
      label: basename(path).replace(/\.json$/i, ''),
      path
    }))
  const revisions = resolvedInputs.map(({ label, path }) => {
    const report = readJsonReport(path)
    return {
      label,
      path,
      stats: report.stats ?? null,
      rows: collectTerminalPerfRows(report, label)
    }
  })
  const totalRows = revisions.reduce((sum, revision) => sum + revision.rows.length, 0)
  if (totalRows === 0) {
    throw new Error('No opencode terminal perf annotations found in the provided reports')
  }
  const html = renderHtml({ generatedAt: now.toISOString(), revisions })
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, html)
  const latestFailures = revisions
    .at(-1)
    .rows.reduce((sum, row) => sum + budgetFailures(row).length, 0)
  return { outputPath, rowCount: totalRows, budgetFailureCount: latestFailures }
}

const isMain = process.argv[1] && import.meta.filename === process.argv[1]
if (isMain) {
  try {
    const { inputs, outputPath } = parseHtmlReportArgs(process.argv.slice(2))
    const result = generateTerminalPerfHtmlReport({ inputs, outputPath })
    console.log(
      `Terminal perf HTML report saved to ${result.outputPath} (${result.rowCount} rows, ${result.budgetFailureCount} budget failures).`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
