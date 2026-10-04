import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareIds } from './ci-shard-assignment.mjs'

export function importUnitTimingReports(reports) {
  const first = reports[0]
  if (!first || first.shard.count !== reports.length) {
    throw new Error('Expected exactly one complete unit shard set')
  }
  const provenance = (report) =>
    JSON.stringify([
      report.sourceSha,
      report.runId,
      report.runAttempt,
      report.nodeVersion,
      report.shard.count
    ])
  const indices = new Set()
  const timings = {}
  for (const report of reports) {
    if (
      report.metric !== 'module-duration-v1' ||
      report.status !== 'passed' ||
      report.unhandledErrors !== 0 ||
      !report.sourceSha ||
      provenance(report) !== provenance(first)
    ) {
      throw new Error('Unit timing reports must come from one successful source/run/Node version')
    }
    const { index, count } = report.shard
    if (!Number.isInteger(index) || index < 1 || index > count || indices.has(index)) {
      throw new Error('Duplicate or invalid unit shard index')
    }
    indices.add(index)
    for (const [file, duration] of Object.entries(report.timings)) {
      if (file in timings || !Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Duplicate or invalid unit timing: ${file}`)
      }
      timings[file] = duration
    }
  }
  if (!Object.keys(timings).length) {
    throw new Error('No unit timing evidence')
  }
  return {
    runId: first.runId,
    runAttempt: first.runAttempt,
    sourceSha: first.sourceSha,
    nodeVersion: first.nodeVersion,
    metric: first.metric,
    // Per-module measurements already include setup, imports and environment startup.
    overheadMs: 0,
    timings: Object.fromEntries(Object.entries(timings).sort(([a], [b]) => compareIds(a, b)))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, output] = process.argv.slice(2)
  if (!directory || !output) {
    throw new Error('Usage: ci-unit-timing-import.mjs ARTIFACT_DIRECTORY BASELINE_JSON')
  }
  const reports = readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith('unit-timings.json'))
    .map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')))
  const baseline = JSON.parse(readFileSync(output, 'utf8'))
  baseline.unit = importUnitTimingReports(reports)
  writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`)
}
