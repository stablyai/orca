// 4a rows, percentiles and the PR-body table: main vs candidate per row, keyed by each arm's head SHA.
import type { HostWork } from './native-chat-4a-probes'

export type Sample = {
  /** Action to user-visible (or durably readable, when the row says so) result. */
  e2eMs?: number
  /** The RPC's renderer round trip: host handling including storage. */
  hostMs?: number
  work?: HostWork
  /** Row-specific spans and sizes, e.g. firstTextMs, walBytes, bytes, items, queueLength. */
  extra?: Record<string, number>
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
  startedAt: string
  finishedAt: string
  rows: Row[]
  fixture: Record<string, number | string>
}

export type Stat = { n: number; p50: number; p95: number; max: number }

function nearestRank(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))]!
}

export function stat(values: (number | undefined)[]): Stat | null {
  const sorted = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.at(-1)!
  }
}

export function summarizeRow(row: Row) {
  const extras = new Set(row.samples.flatMap((sample) => Object.keys(sample.extra ?? {})))
  return {
    e2eMs: stat(row.samples.map((sample) => sample.e2eMs)),
    hostMs: stat(row.samples.map((sample) => sample.hostMs)),
    hostCpuMs: stat(row.samples.map((sample) => sample.work?.cpuMs)),
    offMainThreadCpuMs: stat(row.samples.map((sample) => sample.work?.offMainThreadCpuMs)),
    mainThreadActiveMs: stat(row.samples.map((sample) => sample.work?.mainThreadActiveMs)),
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

function delta(base: Stat | null, next: Stat | null): string {
  if (!base || !next) {
    return '—'
  }
  const change = next.p95 - base.p95
  const percent =
    base.p95 > 0 ? ` (${change >= 0 ? '+' : ''}${((change / base.p95) * 100).toFixed(0)}%)` : ''
  return `${change >= 0 ? '+' : ''}${ms(change)}${percent}`
}

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
    `| Family | Operation | Case | ${base.arm} | ${next.arm} | Δ p95 | Host span p95 ${base.arm} → ${next.arm} | Off-main CPU p95 ${base.arm} → ${next.arm} | Shape |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const seen = new Set<string>()
  for (const row of ordered) {
    if (seen.has(key(row))) {
      continue
    }
    seen.add(key(row))
    const left = baseRows.get(key(row))
    const right = nextRows.get(key(row))
    const a = left ? summarizeRow(left) : null
    const b = right ? summarizeRow(right) : null
    const span = (summary: typeof a, pick: 'hostMs' | 'offMainThreadCpuMs'): string =>
      summary?.[pick] ? ms(summary[pick]!.p95) : '—'
    lines.push(
      `| ${row.family} | ${row.operation} | ${caseCell(row)} | ${left?.skipped ? `skipped: ${left.skipped}` : cell(a && primary(a))} | ${right?.skipped ? `skipped: ${right.skipped}` : cell(b && primary(b))} | ${delta(a && primary(a), b && primary(b))} | ${span(a, 'hostMs')} → ${span(b, 'hostMs')} | ${span(a, 'offMainThreadCpuMs')} → ${span(b, 'offMainThreadCpuMs')} | ${contextCell(left ?? right)} |`
    )
  }
  lines.push(
    '',
    'Primary latency is action → visible result where the row has a rendered end point, else the RPC host span. Off-main CPU is process CPU minus main-thread event-loop active time (storage workers). Conversion rows are one-time import cost, reported separately from steady state; per-row spans, WAL/file growth, event-loop lag and peak memory are in the JSON.'
  )
  return `${lines.join('\n')}\n`
}

export function armMarkdown(result: ArmResult): string {
  const lines = [
    `4a ${result.arm} \`${result.sha.slice(0, 11)}\` (p50 / p95 / max ms).`,
    '',
    '| Family | Operation | Case | Primary | Host span | Shape |',
    '| --- | --- | --- | --- | --- | --- |'
  ]
  for (const row of result.rows) {
    const summary = summarizeRow(row)
    lines.push(
      `| ${row.family} | ${row.operation} | ${caseCell(row)} | ${row.skipped ? `skipped: ${row.skipped}` : cell(primary(summary))} | ${cell(summary.hostMs)} | ${contextCell(row)} |`
    )
  }
  return `${lines.join('\n')}\n`
}
