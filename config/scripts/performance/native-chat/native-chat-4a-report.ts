// 4a rows, percentiles and the PR-body table: main vs candidate per row, keyed by each arm's pinned full SHA.
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ArmProvenance } from './native-chat-4a-arm-provenance'
import type { HostWork } from './native-chat-4a-probes'
import type { Workload } from './native-chat-4a-workloads'
import { comparisonInvalid } from './native-chat-4a-history-shape'

export type Sample = {
  /** Action to user-visible (or durably readable, when the row says so) result. */
  e2eMs?: number
  /** The RPC's renderer round trip: host handling including storage. */
  hostMs?: number
  work?: HostWork
  /** Row-specific spans and sizes, e.g. firstTextMs, walBytes, bytes, items, queueLength. */
  extra?: Record<string, number>
  evidence?: Record<string, unknown>
}

export type Row = {
  family: string
  operation: string
  /** e.g. cold, warm, 8MiB nobreak; rows match across arms by family/operation/variant. */
  variant: string
  samples: Sample[]
  /** Shape facts that hold for the whole row: bytes, items, queue length, concurrent work. */
  context: Record<string, number | string>
  /** Why a row has no samples on this arm, so absence is never read as a pass. */
  skipped?: string
  /** Sub-spans this row cannot separate without a product hook; the table marks it "end-to-end only". */
  endToEndOnly?: string
}

export type ArmResult = {
  arm: string
  sha: string
  provenance: ArmProvenance
  startedAt: string
  finishedAt: string
  rows: Row[]
  fixture: Record<string, number | string>
}

export { stat, type Stat } from './native-chat-4a-stats'
import { stat, type Stat } from './native-chat-4a-stats'
import { memoryComparison, memoryMarkdown } from './native-chat-4a-memory-report'
export { memoryComparison } from './native-chat-4a-memory-report'

export function summarizeRow(row: Row) {
  const extras = new Set(row.samples.flatMap((sample) => Object.keys(sample.extra ?? {})))
  return {
    e2eMs: stat(row.samples.map((sample) => sample.e2eMs)),
    hostMs: stat(row.samples.map((sample) => sample.hostMs)),
    processCpuMs: stat(row.samples.map((sample) => sample.work?.processCpuMs)),
    mainThreadEluActiveMs: stat(row.samples.map((sample) => sample.work?.mainThreadEluActiveMs)),
    mainThreadTimerDelayP99Ms: stat(
      row.samples.map((sample) => sample.work?.mainThreadTimerDelayP99Ms)
    ),
    mainThreadTimerDelayMaxMs: stat(
      row.samples.map((sample) => sample.work?.mainThreadTimerDelayMaxMs)
    ),
    extra: Object.fromEntries(
      [...extras].map((key) => [key, stat(row.samples.map((sample) => sample.extra?.[key]))])
    )
  }
}

const key = (row: Pick<Row, 'family' | 'operation' | 'variant'>): string =>
  `${row.family}\u0000${row.operation}\u0000${row.variant}`
const ms = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
const cell = (value: Stat | null): string =>
  value ? `${ms(value.p50)} / ${ms(value.p95)} / ${ms(value.max)} (n=${value.n})` : '—'

const unavailable = (row?: Row): string | undefined =>
  row?.skipped ?? (!row?.samples.length ? 'unexercised: no samples' : undefined)

function delta(base: Stat | null, next: Stat | null): string {
  if (!base || !next) {
    return '—'
  }
  const change = next.p95 - base.p95
  const percent =
    base.p95 > 0 ? ` (${change >= 0 ? '+' : ''}${((change / base.p95) * 100).toFixed(0)}%)` : ''
  return `${change >= 0 ? '+' : ''}${ms(change)}${percent}`
}

/** One line per arm: the full pinned SHA and the build output that proved it. */
const provenanceLine = ({ arm, provenance: p }: ArmResult): string =>
  `- ${arm}: \`${p.sha}\` (pinned \`${p.expectedSha}\`, committed ${p.headCommittedAt}); clean product sources; build stamp \`${p.builtCommit}\` in ${p.stampFiles}; out/main/index.js sha256 \`${p.mainBundleSha256}\`; built ${p.artifactBuiltAt}, after the newest source ${p.newestSourceFile} (${p.newestSourceModifiedAt}).`

// No product hook or timing field exposes it, and SQLite state records no transaction start, so it is disclosed, not derived.
const WRITER_SPAN_DISCLOSURE =
  'Not measured: writer BEGIN → COMMIT and grouped-transaction spans. Neither arm exposes them without a product hook, and on-disk SQLite state records commits but not when a transaction began; host spans above include storage but are not transaction durations.'

const caseCell = (row: Row): string =>
  row.endToEndOnly ? `${row.variant} (end-to-end only: ${row.endToEndOnly})` : row.variant

/** The row's primary latency: visible result where measured, else the host span. */
const primary = (summary: ReturnType<typeof summarizeRow>): Stat | null =>
  summary.e2eMs ?? summary.hostMs

function contextCell(row: Row | undefined): string {
  if (!row) {
    return ''
  }
  return Object.entries(row.context)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')
}

export function comparisonMarkdown(base: ArmResult, next: ArmResult): string {
  const nextRows = new Map(next.rows.map((row) => [key(row), row]))
  const baseRows = new Map(base.rows.map((row) => [key(row), row]))
  const ordered = [...base.rows, ...next.rows.filter((row) => !baseRows.has(key(row)))]
  const lines = [
    `4a comparison: ${base.arm} \`${base.sha.slice(0, 11)}\` vs ${next.arm} \`${next.sha.slice(0, 11)}\` (p50 / p95 / max ms, nearest rank).`,
    '',
    provenanceLine(base),
    provenanceLine(next),
    '',
    `| Family | Operation | Case | ${base.arm} | ${next.arm} | Δ p95 | Host span p95 ${base.arm} → ${next.arm} | Process CPU p95 ${base.arm} → ${next.arm} | Main-thread ELU active wall ms p95 ${base.arm} → ${next.arm} | Main timer delay p99, p95 ${base.arm} → ${next.arm} | Shape |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const seen = new Set<string>()
  for (const row of ordered) {
    if (row.family === 'memory') {
      continue
    }
    if (seen.has(key(row))) {
      continue
    }
    seen.add(key(row))
    const left = baseRows.get(key(row))
    const right = nextRows.get(key(row))
    const unmatched = comparisonInvalid(left, right)
    const a = left ? summarizeRow(left) : null
    const b = right ? summarizeRow(right) : null
    const span = (
      summary: typeof a,
      pick: 'hostMs' | 'processCpuMs' | 'mainThreadEluActiveMs' | 'mainThreadTimerDelayP99Ms'
    ): string => (summary?.[pick] ? ms(summary[pick]!.p95) : '—')
    lines.push(
      `| ${row.family} | ${row.operation} | ${caseCell(row)} | ${unavailable(left) ? `skipped: ${unavailable(left)}` : cell(a && primary(a))} | ${unavailable(right) ? `skipped: ${unavailable(right)}` : cell(b && primary(b))} | ${unmatched ?? delta(a && primary(a), b && primary(b))} | ${span(a, 'hostMs')} → ${span(b, 'hostMs')} | ${span(a, 'processCpuMs')} → ${span(b, 'processCpuMs')} | ${span(a, 'mainThreadEluActiveMs')} → ${span(b, 'mainThreadEluActiveMs')} | ${span(a, 'mainThreadTimerDelayP99Ms')} → ${span(b, 'mainThreadTimerDelayP99Ms')} | ${contextCell(left ?? right)} |`
    )
  }
  lines.push(
    '',
    'Primary latency is action → visible result where the row has a rendered end point, else the RPC host span. Process CPU sums CPU time across all process threads. Main-thread ELU active is event-loop active wall time, including blocking; these independent quantities do not attribute storage-worker CPU. Zero ELU is unavailable. Each timed sample also carries a main-process 10ms timer-delay p99/max/count; a span without a tick is unavailable. Open primary latency ends at the renderer-frame tail and enabled composer; driver completion is separate. History deltas require matching reset/count/cursor/byte shapes (epoch UUIDs normalized to current/stale). Conversion rows are one-time import cost, reported separately from steady state; on an arm with a conversion database, dependent steady-state families are explicitly skipped unless every seeded chat is seen ready. Arms without that database need no conversion; the separate memory copy has its own readiness guard. Rows whose Shape names `observedDatabase` end at an outside read-only SQLite observation and carry its resolution. Per-row spans, WAL/file growth, event-loop lag and peak memory are in the JSON.',
    '',
    WRITER_SPAN_DISCLOSURE
  )
  lines.push(...memoryMarkdown(base, next))
  return `${lines.join('\n')}\n`
}

export function armMarkdown(result: ArmResult): string {
  const lines = [
    `4a ${result.arm} \`${result.sha.slice(0, 11)}\` (p50 / p95 / max ms).`,
    '',
    provenanceLine(result),
    '',
    '| Family | Operation | Case | Primary | Host span | Process CPU | Main-thread ELU active wall ms | Main timer delay p99 | Shape |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const row of result.rows) {
    if (row.family === 'memory') {
      continue
    }
    const summary = summarizeRow(row)
    lines.push(
      `| ${row.family} | ${row.operation} | ${caseCell(row)} | ${unavailable(row) ? `skipped: ${unavailable(row)}` : cell(primary(summary))} | ${cell(summary.hostMs)} | ${cell(summary.processCpuMs)} | ${cell(summary.mainThreadEluActiveMs)} | ${cell(summary.mainThreadTimerDelayP99Ms)} | ${contextCell(row)} |`
    )
  }
  lines.push(
    '',
    'Main timer delay measures lateness of a 10ms main-process timer. No tick or zero ELU means unavailable. Open primary uses renderer-frame tail/composer timestamps; driver completion is separate.',
    '',
    WRITER_SPAN_DISCLOSURE
  )
  lines.push(...memoryMarkdown(result))
  return `${lines.join('\n')}\n`
}

/** The comparison JSON (every sample and summary, the workload and machine) beside its table. */
export function writeComparison(
  out: string,
  workload: Workload,
  results: ArmResult[],
  log: (line: string) => void
): void {
  const [base, next] = results
  if (!base || !next) {
    return
  }
  const name = `4a-${base.sha.slice(0, 8)}-vs-${next.sha.slice(0, 8)}`
  const summaries = results.map((result) => ({
    ...result,
    summaries: result.rows.map((row: Row) => ({ ...row, summary: summarizeRow(row) }))
  }))
  const paired = new Map(next.rows.map((row) => [key(row), row]))
  const comparisons = base.rows
    .filter((row) => row.family !== 'memory')
    .map((left) => {
      const right = paired.get(key(left))
      const invalid = comparisonInvalid(left, right)
      const a = primary(summarizeRow(left))
      const b = right ? primary(summarizeRow(right)) : null
      return {
        family: left.family,
        operation: left.operation,
        variant: left.variant,
        invalid,
        p95DeltaMs: !invalid && a && b ? b.p95 - a.p95 : null
      }
    })
  const machine = {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem()
  }
  writeFileSync(
    path.join(out, `${name}.json`),
    `${JSON.stringify({ workload, machine, arms: summaries, comparisons, memoryComparison: memoryComparison(base, next) }, null, 2)}\n`
  )
  writeFileSync(path.join(out, `${name}.md`), comparisonMarkdown(base, next))
  log(`wrote ${path.join(out, `${name}.md`)}`)
}
