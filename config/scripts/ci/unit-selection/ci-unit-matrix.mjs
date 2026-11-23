import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const FULL_SHARD_COUNT = 16

export function fullUnitMatrix(requestedCount = String(FULL_SHARD_COUNT)) {
  if (!/^([2-9]|[12][0-9]|3[0-2])$/.test(requestedCount)) {
    throw new Error('ORCA_UNIT_FULL_SHARD_COUNT must be an integer from 2 to 32')
  }
  const count = Number(requestedCount)
  return Array.from({ length: count }, (_, index) => ({ index: index + 1, count }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shards = fullUnitMatrix(process.env.ORCA_UNIT_FULL_SHARD_COUNT)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `shards=${JSON.stringify(shards)}\n`)
  }
  console.log(`Full unit inventory; ${shards.length} shards. Shadow selection is advisory.`)
}
