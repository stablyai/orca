import { pathToFileURL } from 'node:url'

const INVENTORY_PREFIX = '[orca-relay] regional rehome inventory '
// A counters line, so every field is a bare name and a non-negative integer or
// `none`. Pinning the whole line instead is what broke the enable workflow when
// `hostNotArrivedLast24Hours` shipped: the director grew a field and the parser
// read a healthy line as no evidence at all. Tolerating extra fields is safe
// only because the value shape stays fenced — `hostId=someone` is still not a
// counter, so an identity-bearing lookalike cannot slip through as an extra.
const FIELD = /^([A-Za-z][A-Za-z0-9]*)=(none|\d{1,15})$/
// `oldestActiveAgeMs` is the one required field the director can report as
// `none`; a count that reads `none` is a line this parser does not recognise,
// not evidence worth failing the run over.
const REQUIRED_COUNTS = [
  'active',
  'awaitingReceipt',
  'targetRegistered',
  'completedLast24Hours',
  'abortedLast24Hours'
]
const REQUIRED_FIELDS = [...REQUIRED_COUNTS, 'oldestActiveAgeMs']

function count(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}

// Returns the field map, or null for anything that is not this line.
export function readRegionalRehomeInventoryFields(textPayload) {
  if (typeof textPayload !== 'string' || !textPayload.startsWith(INVENTORY_PREFIX)) return null
  const fields = new Map()
  for (const token of textPayload.slice(INVENTORY_PREFIX.length).split(' ')) {
    const field = FIELD.exec(token)
    if (!field || fields.has(field[1])) return null
    fields.set(field[1], field[2])
  }
  if (!REQUIRED_FIELDS.every((name) => fields.has(name))) return null
  if (REQUIRED_COUNTS.some((name) => fields.get(name) === 'none')) return null
  return fields
}

// Absent is not zero: a director on an older image emits no such field, and
// reporting 0 would read as "no leaks" rather than "not measured".
function optionalCount(fields, name) {
  const value = fields.get(name)
  if (value === undefined || value === 'none') return null
  return count(value, name)
}

export function parseRegionalRehomeInventory(entries, options = {}) {
  if (!Array.isArray(entries)) throw new Error('logging response must be an array')
  const parsed = entries.flatMap((entry) => {
    const fields = readRegionalRehomeInventoryFields(entry?.textPayload ?? '')
    const timestamp = Date.parse(entry?.timestamp ?? '')
    if (!fields || !Number.isFinite(timestamp)) return []
    return [{
      timestamp,
      active: count(fields.get('active'), 'active'),
      awaitingReceipt: count(fields.get('awaitingReceipt'), 'awaiting receipt'),
      targetRegistered: count(fields.get('targetRegistered'), 'target registered'),
      completedLast24Hours: count(fields.get('completedLast24Hours'), 'completed'),
      abortedLast24Hours: count(fields.get('abortedLast24Hours'), 'aborted'),
      hostNotArrivedLast24Hours: optionalCount(fields, 'hostNotArrivedLast24Hours'),
      oldestActiveAgeMs: optionalCount(fields, 'oldestActiveAgeMs')
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
