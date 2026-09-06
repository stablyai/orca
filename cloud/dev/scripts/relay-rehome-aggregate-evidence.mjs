import { pathToFileURL } from 'node:url'

const INVENTORY = /^\[orca-relay\] regional rehome inventory active=(\d+) awaitingReceipt=(\d+) targetRegistered=(\d+) completedLast24Hours=(\d+) abortedLast24Hours=(\d+) oldestActiveAgeMs=(none|\d+)$/

function count(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}

export function parseRegionalRehomeInventory(entries, options = {}) {
  if (!Array.isArray(entries)) throw new Error('logging response must be an array')
  const parsed = entries.flatMap((entry) => {
    const match = INVENTORY.exec(entry?.textPayload ?? '')
    const timestamp = Date.parse(entry?.timestamp ?? '')
    if (!match || !Number.isFinite(timestamp)) return []
    return [{
      timestamp,
      active: count(match[1], 'active'),
      awaitingReceipt: count(match[2], 'awaiting receipt'),
      targetRegistered: count(match[3], 'target registered'),
      completedLast24Hours: count(match[4], 'completed'),
      abortedLast24Hours: count(match[5], 'aborted'),
      oldestActiveAgeMs: match[6] === 'none' ? null : count(match[6], 'oldest active age')
    }]
  }).sort((left, right) => right.timestamp - left.timestamp)
  if (parsed.length === 0) throw new Error('no aggregate regional rehome inventory evidence')
  const latest = parsed[0]
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000
  if (latest.timestamp > now + 60_000 || latest.timestamp < now - maxAgeMs) {
    throw new Error('aggregate regional rehome inventory evidence is stale')
  }
  return latest
}

function argumentsMap(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('invalid arguments')
    }
    values[argv[index].slice(2)] = argv[index + 1]
  }
  return values
}

export async function main(argv = process.argv.slice(2), input = process.stdin) {
  const values = argumentsMap(argv)
  const maxAgeMs = count(values['max-age-ms'] ?? 900_000, '--max-age-ms')
  const chunks = []
  for await (const chunk of input) chunks.push(chunk)
  const evidence = parseRegionalRehomeInventory(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
    { maxAgeMs }
  )
  process.stdout.write(`${JSON.stringify({ event: 'relay_rehome_aggregate_evidence', ...evidence })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
