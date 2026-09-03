import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MODES = new Set([
  'inspect', 'initialize', 'verify', 'registered', 'register',
  'promote', 'recover-promotion', 'rollback'
])
const STATES = new Set(['absent', 'existing-only', 'migration-only', 'general'])

function validCellId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}

function cellIds(value, label) {
  if (
    !Array.isArray(value) || value.length > 256 ||
    value.some((cellId) => !validCellId(cellId))
  ) {
    throw new Error(`${label} is invalid`)
  }
  return [...value]
}

function membership(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('membership is invalid')
  }
  return {
    existingOnly: cellIds(value.existingOnly, 'existing-only membership'),
    migrationOnly: cellIds(value.migrationOnly, 'migration-only membership'),
    general: cellIds(value.general, 'general membership')
  }
}

function states(value) {
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('states are invalid')
  const entries = Object.entries(value)
  if (
    entries.length === 0 || entries.length > 256 ||
    entries.some(([cellId, state]) => !validCellId(cellId) || !STATES.has(state))
  ) {
    throw new Error('states are invalid')
  }
  return Object.fromEntries(entries)
}

function optionalBoolean(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`)
  return value
}

export function sanitizeRelayAsiaAdmissionResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('admission result must be an object')
  }
  if (!MODES.has(input.mode)) throw new Error('mode is invalid')
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('generation is invalid')
  }
  if (
    input.membershipSha256 !== undefined && input.membershipSha256 !== null &&
    !/^[a-f0-9]{64}$/.test(input.membershipSha256)
  ) throw new Error('membership SHA-256 is invalid')
  const sanitizedMembership = membership(input.membership)
  if (
    input.mode === 'inspect' &&
    (sanitizedMembership === null || !/^[a-f0-9]{64}$/.test(input.membershipSha256 ?? ''))
  ) throw new Error('inspect membership evidence is incomplete')
  const recovered = optionalBoolean(input.recovered, 'recovered')
  const promoted = optionalBoolean(input.promoted, 'promoted')
  if (input.mode === 'recover-promotion' && promoted === null) {
    throw new Error('promotion recovery evidence is incomplete')
  }
  return {
    v: 1,
    mode: input.mode,
    generation: input.generation,
    states: states(input.states),
    membership: sanitizedMembership,
    membershipSha256: input.membershipSha256 ?? null,
    recovered,
    promoted
  }
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(sanitizeRelayAsiaAdmissionResult(input))}\n`)
  } catch {
    console.error('invalid Relay Asia admission result')
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
