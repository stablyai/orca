// 4a rows, percentiles and the PR-body table: main vs candidate per row, keyed by each arm's pinned full SHA.
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ArmProvenance } from './native-chat-4a-arm-provenance'
import type { HostWork } from './native-chat-4a-probes'
import type { Workload } from './native-chat-4a-workloads'

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
  provenance: ArmProvenance
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

function memoryValue(row: Row | undefined): number | null {
  return row?.skipped
    ? null
    : (stat(row?.samples.map((sample) => sample.extra?.bytes) ?? [])?.p50 ?? null)
}

/** Positive reduction means the candidate uses fewer bytes; negative activation deltas have no relative denominator. */
export function memoryComparison(base: ArmResult, next: ArmResult) {
  const left = new Map(
    base.rows.filter((row) => row.family === 'memory').map((row) => [key(row), row])
  )
  const right = new Map(
    next.rows.filter((row) => row.family === 'memory').map((row) => [key(row), row])
  )
  return [...new Set([...left.keys(), ...right.keys()])].map((id) => {
    const a = left.get(id)
    const b = right.get(id)
    if (a && b && !a.skipped && !b.skipped) {
      for (const field of [
        'seedRecipe',
        'seedSha',
        'chats',
        'completedToolsPerChat',
        'toolOutputBytes'
      ]) {
        if (a.context[field] === undefined || a.context[field] !== b.context[field]) {
          throw new Error(
            `memory comparison: arms disagree on or lack ${field}; use one identical seed`
          )
        }
      }
    }
    const mainBytes = memoryValue(a)
    const candidateBytes = memoryValue(b)
    const reductionBytes =
      mainBytes === null || candidateBytes === null ? null : mainBytes - candidateBytes
    return {
      operation: (a ?? b)!.operation,
      phase: (a ?? b)!.variant,
      mainBytes,
      candidateBytes,
      reductionBytes,
      reductionPercent:
        reductionBytes !== null && mainBytes !== null && mainBytes > 0
          ? (reductionBytes / mainBytes) * 100
          : null,
      mainSkipped: a?.skipped ?? (mainBytes === null ? 'measurement missing' : null),
      candidateSkipped: b?.skipped ?? (candidateBytes === null ? 'measurement missing' : null)
    }
  })
}

function memoryMarkdown(base: ArmResult, next?: ArmResult): string[] {
  const compared = memoryComparison(base, next ?? base)
  if (compared.length === 0) {
    return []
  }
  const bytes = (value: number | null, skipped?: string | null): string =>
    skipped
      ? `skipped: ${skipped}`
      : value === null
        ? 'skipped: measurement missing'
        : value.toFixed(0)
  const lines = [
    '',
    'Main-process memory (bytes; median of the final stable 5-sample window). Each arm uses its own copy of one separate uniform seed. Conversion completes before the baseline. Every chat is opened through history and held subscribed until both active samples finish; no provider starts. The baseline can already include chats restored at startup, so compare absolute active bytes as well as activation deltas. These counts model the eight-hour completed-tool workload; this is not an eight-hour soak.',
    '',
    next
      ? `| Counter | Phase | ${base.arm} bytes | ${next.arm} bytes | Reduction bytes | Reduction % |`
      : `| Counter | Phase | ${base.arm} bytes |`,
    next ? '| --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- |'
  ]
  for (const row of compared) {
    const cells = [row.operation, row.phase, bytes(row.mainBytes, row.mainSkipped)]
    if (next) {
      cells.push(
        bytes(row.candidateBytes, row.candidateSkipped),
        bytes(row.reductionBytes),
        row.reductionPercent === null ? '—' : `${row.reductionPercent.toFixed(2)}%`
      )
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push(
    '',
    'RSS is process.memoryUsage().rss for the whole main process including workers, not macOS physical footprint. heapUsed/external/arrayBuffers cover the main V8 isolate. external includes arrayBuffers; do not sum them. Activation deltas subtract phase medians. GC runs only when main already exposes global.gc; unavailable or failed counters are explicitly skipped. Positive reduction means fewer candidate bytes. Seed time and logical file bytes (including the isolated provider home, not APFS allocated blocks) are recorded in each arm fixture and row Shape.'
  )
  for (const result of next ? [base, next] : [base]) {
    const row = result.rows.find((value) => value.family === 'memory')
    if (row) {
      lines.push('', `${result.arm} memory Shape: ${contextCell(row)}`)
    }
  }
  return lines
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
    `| Family | Operation | Case | ${base.arm} | ${next.arm} | Δ p95 | Host span p95 ${base.arm} → ${next.arm} | Off-main CPU p95 ${base.arm} → ${next.arm} | Shape |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
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
    'Primary latency is action → visible result where the row has a rendered end point, else the RPC host span. Off-main CPU is process CPU minus main-thread event-loop active time (storage workers). Conversion rows are one-time import cost, reported separately from steady state; steady-state families start only after every chat is seen ready. Rows whose Shape names `observedDatabase` end at an outside read-only SQLite observation and carry its resolution. Per-row spans, WAL/file growth, event-loop lag and peak memory are in the JSON.',
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
    '| Family | Operation | Case | Primary | Host span | Shape |',
    '| --- | --- | --- | --- | --- | --- |'
  ]
  for (const row of result.rows) {
    if (row.family === 'memory') {
      continue
    }
    const summary = summarizeRow(row)
    lines.push(
      `| ${row.family} | ${row.operation} | ${caseCell(row)} | ${row.skipped ? `skipped: ${row.skipped}` : cell(primary(summary))} | ${cell(summary.hostMs)} | ${contextCell(row)} |`
    )
  }
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
  const machine = {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem()
  }
  writeFileSync(
    path.join(out, `${name}.json`),
    `${JSON.stringify({ workload, machine, arms: summaries, memoryComparison: memoryComparison(base, next) }, null, 2)}\n`
  )
  writeFileSync(path.join(out, `${name}.md`), comparisonMarkdown(base, next))
  log(`wrote ${path.join(out, `${name}.md`)}`)
}
