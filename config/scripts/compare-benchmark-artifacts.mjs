import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectTerminalPerfRows } from './terminal-perf-report-annotations.mjs'

const USAGE =
  'Usage: node config/scripts/compare-benchmark-artifacts.mjs --baseline <path> --candidate <path> [--title <title>] [--output <path>] [--json-output <path>] [--higher-is-better <metric-key> ...]'

const PLAYWRIGHT_METADATA_FIELDS = new Set(['source', 'scenario', 'panes', 'frames', 'samples'])

export function parseBenchmarkComparisonArgs(argv = process.argv.slice(2)) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  const parsed = {
    higherIsBetter: new Set(),
    title: 'Benchmark comparison'
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--baseline') {
      parsed.baselinePath = readRequiredValue(args, ++index, '--baseline requires a path')
      continue
    }
    if (flag === '--candidate') {
      parsed.candidatePath = readRequiredValue(args, ++index, '--candidate requires a path')
      continue
    }
    if (flag === '--title') {
      parsed.title = readRequiredValue(args, ++index, '--title requires a value')
      continue
    }
    if (flag === '--output') {
      parsed.outputPath = readRequiredValue(args, ++index, '--output requires a path')
      continue
    }
    if (flag === '--json-output') {
      parsed.jsonOutputPath = readRequiredValue(args, ++index, '--json-output requires a path')
      continue
    }
    if (flag === '--higher-is-better') {
      let consumed = 0
      while (args[index + 1] != null && !args[index + 1].startsWith('--')) {
        parsed.higherIsBetter.add(args[index + 1])
        index += 1
        consumed += 1
      }
      if (consumed === 0) {
        throw new Error('--higher-is-better requires a metric key')
      }
      continue
    }
    throw new Error(USAGE)
  }

  if (!parsed.baselinePath) {
    throw new Error(USAGE)
  }
  if (!parsed.candidatePath) {
    throw new Error(USAGE)
  }
  return parsed
}

function readRequiredValue(args, index, message) {
  const value = args[index]
  if (value == null || value.startsWith('--')) {
    throw new Error(message)
  }
  return value
}

export function readBenchmarkArtifact(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function normalizeBenchmarkArtifact(path, artifact = readBenchmarkArtifact(path)) {
  if (artifact?.summaryMedianMs != null) {
    return normalizeNumericObject(path, artifact, 'startup', artifact.summaryMedianMs, () => 'ms')
  }
  if (artifact?.summaryMedian != null) {
    return normalizeNumericObject(path, artifact, 'daemon', artifact.summaryMedian, (key) =>
      key.endsWith('Count') || key.endsWith('After') ? 'count' : 'ms'
    )
  }
  if (artifact?.suites != null) {
    return normalizePlaywrightArtifact(path, artifact)
  }
  if (artifact?.summary != null) {
    return normalizeSummaryArtifact(path, artifact)
  }
  throw new Error(
    `${path}: unsupported benchmark artifact; expected summaryMedianMs, summaryMedian, Playwright suites, or top-level summary`
  )
}

function artifactLabel(path, artifact) {
  return typeof artifact?.label === 'string' && artifact.label.length > 0
    ? artifact.label
    : basename(path)
}

function normalizeNumericObject(path, artifact, kind, values, unitForKey) {
  return {
    kind,
    label: artifactLabel(path, artifact),
    metrics: Object.entries(values ?? {})
      .filter(([, value]) => Number.isFinite(value))
      .map(([key, value]) => ({
        direction: 'lower-is-better',
        key,
        unit: unitForKey(key),
        value
      }))
  }
}

function normalizePlaywrightArtifact(path, artifact) {
  const rows = collectTerminalPerfRows(artifact, basename(path), { typePrefix: 'opencode-' })
  const groupedMetrics = new Map()
  for (const row of rows) {
    for (const [field, rawValue] of Object.entries(row)) {
      if (PLAYWRIGHT_METADATA_FIELDS.has(field)) {
        continue
      }
      const parsed = parseMetricValue(rawValue)
      if (parsed == null) {
        continue
      }
      const key = `${row.scenario}.${field}`
      const metricGroup = groupedMetrics.get(key) ?? {
        unit: parsed.unit,
        values: []
      }
      metricGroup.values.push(parsed.value)
      groupedMetrics.set(key, metricGroup)
    }
  }
  const metrics = [...groupedMetrics.entries()].map(([key, metricGroup]) => ({
    direction: 'lower-is-better',
    key,
    unit: metricGroup.unit,
    value: mean(metricGroup.values)
  }))
  return {
    kind: 'playwright',
    label: artifactLabel(path, artifact),
    metrics
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function parseMetricValue(rawValue) {
  if (typeof rawValue === 'string') {
    const msMatch = rawValue.match(/^(-?\d+(?:\.\d+)?)ms$/)
    if (msMatch) {
      return { unit: 'ms', value: Number(msMatch[1]) }
    }
  }
  const numericValue = Number(rawValue)
  if (!Number.isFinite(numericValue)) {
    return null
  }
  return { unit: 'count', value: numericValue }
}

function normalizeSummaryArtifact(path, artifact) {
  const metrics = []
  flattenSummary(metrics, ['summary'], artifact.summary)
  return {
    kind: 'summary',
    label: artifactLabel(path, artifact),
    metrics
  }
}

function flattenSummary(metrics, pathParts, value) {
  if (Number.isFinite(value)) {
    const key = pathParts.join('.')
    metrics.push({
      direction: 'lower-is-better',
      key,
      unit: unitForSummaryKey(pathParts),
      value
    })
    return
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    flattenSummary(metrics, [...pathParts, childKey], childValue)
  }
}

function unitForSummaryKey(pathParts) {
  if (pathParts.some((part) => part.endsWith('CpuPercent'))) {
    return '%'
  }
  if (pathParts.some((part) => part.endsWith('Bytes'))) {
    return 'bytes'
  }
  return ''
}

export function compareBenchmarkArtifacts({
  baselinePath,
  candidatePath,
  title = 'Benchmark comparison',
  higherIsBetter = new Set(),
  now = () => new Date()
}) {
  const baseline = normalizeBenchmarkArtifact(baselinePath)
  const candidate = normalizeBenchmarkArtifact(candidatePath)
  const candidateMetrics = new Map(candidate.metrics.map((metric) => [metric.key, metric]))
  const baselineMetrics = new Map(baseline.metrics.map((metric) => [metric.key, metric]))
  const metrics = []
  const skippedMetrics = []

  for (const baselineMetric of baseline.metrics) {
    const candidateMetric = candidateMetrics.get(baselineMetric.key)
    if (!isComparableMetric(baselineMetric)) {
      skippedMetrics.push({ key: baselineMetric.key, reason: 'missing baseline metric' })
      continue
    }
    if (!isComparableMetric(candidateMetric)) {
      skippedMetrics.push({ key: baselineMetric.key, reason: 'missing candidate metric' })
      continue
    }
    if (baselineMetric.unit !== candidateMetric.unit) {
      skippedMetrics.push({
        key: baselineMetric.key,
        reason: `unit mismatch (${formatUnitLabel(baselineMetric.unit)} vs ${formatUnitLabel(candidateMetric.unit)})`
      })
      continue
    }
    const direction = higherIsBetter.has(baselineMetric.key)
      ? 'higher-is-better'
      : baselineMetric.direction
    metrics.push(compareMetric(baselineMetric, candidateMetric, direction))
  }

  for (const candidateMetric of candidate.metrics) {
    if (!baselineMetrics.has(candidateMetric.key)) {
      skippedMetrics.push({ key: candidateMetric.key, reason: 'missing baseline metric' })
    }
  }

  if (metrics.length === 0) {
    throw new Error('No comparable benchmark metrics found.')
  }

  return {
    schemaVersion: 1,
    createdAt: now().toISOString(),
    title,
    baseline: {
      path: benchmarkDisplayPath(baselinePath),
      label: baseline.label,
      kind: baseline.kind
    },
    candidate: {
      path: benchmarkDisplayPath(candidatePath),
      label: candidate.label,
      kind: candidate.kind
    },
    metrics,
    skippedMetrics
  }
}

function benchmarkDisplayPath(path, cwd = process.cwd()) {
  if (!isAbsolute(path)) {
    return path
  }
  const relativePath = relative(cwd, path)
  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return relativePath
  }
  return basename(path)
}

function isComparableMetric(metric) {
  return metric != null && Number.isFinite(metric.value)
}

function compareMetric(baselineMetric, candidateMetric, direction) {
  const rawDelta = candidateMetric.value - baselineMetric.value
  const absoluteDelta = roundOneDecimal(rawDelta)
  const percentDelta =
    baselineMetric.value === 0
      ? null
      : roundOneDecimal((rawDelta / Math.abs(baselineMetric.value)) * 100)
  return {
    key: baselineMetric.key,
    unit: baselineMetric.unit,
    direction,
    baseline: baselineMetric.value,
    candidate: candidateMetric.value,
    absoluteDelta,
    percentDelta,
    status: metricStatus(absoluteDelta, direction)
  }
}

function formatUnitLabel(unit) {
  return unit === '' ? 'none' : unit
}

function roundOneDecimal(value) {
  return Math.round(value * 10) / 10
}

function metricStatus(absoluteDelta, direction) {
  if (absoluteDelta === 0) {
    return 'unchanged'
  }
  if (direction === 'higher-is-better') {
    return absoluteDelta > 0 ? 'improved' : 'regressed'
  }
  return absoluteDelta < 0 ? 'improved' : 'regressed'
}

export function formatBenchmarkComparisonMarkdown(comparison) {
  const lines = [
    `# ${markdownText(comparison.title)}`,
    '',
    `Baseline: ${markdownText(comparison.baseline.label)} (${markdownText(comparison.baseline.path)})`,
    `Candidate: ${markdownText(comparison.candidate.label)} (${markdownText(comparison.candidate.path)})`,
    `Generated: ${comparison.createdAt}`,
    '',
    '| Metric | Baseline | Candidate | Delta | Delta % | Result |',
    '|---|---:|---:|---:|---:|---|'
  ]
  for (const metric of comparison.metrics) {
    lines.push(
      `| ${markdownTableCell(metric.key)} | ${formatMetricValue(metric.baseline, metric.unit)} | ${formatMetricValue(metric.candidate, metric.unit)} | ${formatMetricValue(metric.absoluteDelta, metric.unit)} | ${formatPercent(metric.percentDelta)} | ${metric.status} |`
    )
  }
  if (comparison.skippedMetrics.length > 0) {
    lines.push('', '## Skipped metrics')
    for (const skippedMetric of comparison.skippedMetrics) {
      lines.push(`- ${markdownText(skippedMetric.key)}: ${markdownText(skippedMetric.reason)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function markdownText(value) {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/[\\`*_{}<>()#+.!-]|\[|\]/g, '\\$&')
}

function markdownTableCell(value) {
  return markdownText(value).replaceAll('|', '\\|')
}

function formatMetricValue(value, unit) {
  return `${Number(value).toFixed(1)}${unit}`
}

function formatPercent(value) {
  return value == null ? '' : `${value.toFixed(1)}%`
}

export function runBenchmarkComparisonCli(args = {}) {
  const argv = args.argv ?? process.argv.slice(2)
  const parsed = parseBenchmarkComparisonArgs(argv)
  const comparison = compareBenchmarkArtifacts(parsed)
  const markdown = formatBenchmarkComparisonMarkdown(comparison)
  if (parsed.outputPath) {
    mkdirSync(dirname(parsed.outputPath), { recursive: true })
    writeFileSync(parsed.outputPath, markdown)
  }
  if (parsed.jsonOutputPath) {
    mkdirSync(dirname(parsed.jsonOutputPath), { recursive: true })
    writeFileSync(parsed.jsonOutputPath, `${JSON.stringify(comparison, null, 2)}\n`)
  }
  const stdout = args.stdout ?? process.stdout
  stdout.write(markdown)
  return comparison
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runBenchmarkComparisonCli()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
