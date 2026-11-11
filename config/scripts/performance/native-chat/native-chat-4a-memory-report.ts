import type { ArmResult, Row } from './native-chat-4a-report'
import { stat } from './native-chat-4a-stats'

const key = (row: Row): string => `${row.operation}\u0000${row.variant}`
const contextCell = (row: Row): string =>
  Object.entries(row.context)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')

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

export function memoryMarkdown(base: ArmResult, next?: ArmResult): string[] {
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
    'RSS is process.memoryUsage().rss for the whole main process including workers, not macOS physical footprint. heapUsed/external/arrayBuffers cover the main V8 isolate. Every raw memory sample includes a read-only inspector worker inventory, role, thread identity and isolate counters. Each worker-reported RSS is the same shared process counter: never sum it or attribute it to one worker. Unsupported or incomplete inventories are explicitly unexercised. external includes arrayBuffers; do not sum them. Activation deltas subtract phase medians. GC runs only when main already exposes global.gc; unavailable or failed counters are explicitly skipped. Positive reduction means fewer candidate bytes. Seed time and logical file bytes (including the isolated provider home, not APFS allocated blocks) are recorded in each arm fixture and row Shape.'
  )
  for (const result of next ? [base, next] : [base]) {
    const row = result.rows.find((value) => value.family === 'memory')
    if (row) {
      lines.push('', `${result.arm} memory Shape: ${contextCell(row)}`)
    }
  }
  lines.push(
    '',
    '| Arm | Memory phase (last window sample) | Observed worker role counts | Worker thread: heapUsed bytes | Shared process RSS bytes |',
    '| --- | --- | --- | --- | --- |'
  )
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {}
  for (const result of next ? [base, next] : [base]) {
    for (const row of result.rows.filter(
      (row) =>
        row.family === 'memory' &&
        row.operation === 'rss' &&
        !row.variant.startsWith('activation delta')
    )) {
      const sample = row.samples.at(-1)
      const inventory = object(sample?.evidence?.workerInventory)
      const workers = Array.isArray(inventory.workers) ? inventory.workers.map(object) : []
      const heaps = workers
        .map((worker) => {
          const memory = object(worker.memory)
          return `${memory.threadId ?? worker.sessionId}: ${memory.heapUsed ?? 'unavailable'}`
        })
        .join(', ')
      const status =
        inventory.complete === true
          ? JSON.stringify(inventory.roleCounts)
          : `unexercised: ${sample?.evidence?.workerError ?? JSON.stringify(inventory.errors) ?? 'inventory unavailable'}`
      lines.push(
        `| ${result.arm} | ${row.variant} | ${status} | ${heaps} | ${inventory.processRssBytes ?? 'unavailable'} |`
      )
    }
  }
  return lines
}
