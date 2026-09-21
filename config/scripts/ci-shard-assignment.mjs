import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function balanceFiles(files, count, timings, overheadMs = 0) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Invalid shard count')
  }
  if (new Set(files).size !== files.length) {
    throw new Error('Duplicate discovered file')
  }
  const known = Object.values(timings).filter((value) => Number.isFinite(value) && value > 0)
  known.sort((a, b) => a - b)
  const fallbackMs = known[Math.floor(known.length / 2)] ?? 1000
  const weighted = files.map((file) => ({
    file,
    durationMs:
      (Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : fallbackMs) +
      overheadMs
  }))
  weighted.sort((a, b) => b.durationMs - a.durationMs || compareIds(a.file, b.file))
  const shards = Array.from({ length: count }, () => ({ files: [], durationMs: 0 }))
  for (const entry of weighted) {
    const target = shards.reduce((best, shard) =>
      shard.durationMs < best.durationMs ||
      (shard.durationMs === best.durationMs && shard.files.length < best.files.length)
        ? shard
        : best
    )
    target.files.push(entry.file)
    target.durationMs += entry.durationMs
  }
  for (const shard of shards) {
    shard.files.sort(compareIds)
  }
  const assigned = shards.flatMap((shard) => shard.files).sort(compareIds)
  if (JSON.stringify(assigned) !== JSON.stringify([...files].sort(compareIds))) {
    throw new Error('Shard coverage differs from discovery')
  }
  return { algorithm: 'file-lpt-v1', fallbackMs, overheadMs, shards }
}

export function readTimingBaseline(suite) {
  const bytes = readFileSync(new URL('./ci-shard-timings.json', import.meta.url), 'utf8')
  const baseline = JSON.parse(bytes)
  return { ...baseline[suite], baselineSha256: createHash('sha256').update(bytes).digest('hex') }
}

export function writeAssignment(path, assignment) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        sourceSha: process.env.ORCA_SHARD_SOURCE_SHA ?? process.env.GITHUB_SHA ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        ...assignment
      },
      null,
      2
    )}\n`
  )
}
