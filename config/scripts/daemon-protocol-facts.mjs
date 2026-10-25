// Reads a build's daemon protocol version and the older versions it can still attach to.
// Parsed from source text so a release tag and a candidate tree are read the same way.
// Usage: node daemon-protocol-facts.mjs <daemon-protocol-version.ts> [output.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DAEMON_PROTOCOL_SOURCE_PATH = 'src/main/daemon/daemon-protocol-version.ts'

const CURRENT_DECLARATION = /^export const PROTOCOL_VERSION\b[^=\n]*=\s*([^\n;]*)/gmu
const PREVIOUS_DECLARATION =
  /^export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS\b[^=\n]*=\s*\[([^\]]*)\]/gmu

function singleMatch(source, pattern, name, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one \`export const ${name}\` declaration, found ${matches.length}`
    )
  }
  return matches[0][1]
}

function parseProtocolInteger(text, name, label) {
  const trimmed = text.trim()
  // Why: a reference like `= NEXT_VERSION` must fail, not coerce to NaN or 0.
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${label}: ${name} must be an integer literal, got \`${trimmed}\``)
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}: ${name} must be a positive integer, got \`${trimmed}\``)
  }
  return value
}

/**
 * @param {string} source
 * @param {string} [label] names the source in errors
 * @returns {{ protocolVersion: number, previousProtocolVersions: number[] }}
 */
export function parseDaemonProtocolFacts(source, label = DAEMON_PROTOCOL_SOURCE_PATH) {
  const protocolVersion = parseProtocolInteger(
    singleMatch(source, CURRENT_DECLARATION, 'PROTOCOL_VERSION', label),
    'PROTOCOL_VERSION',
    label
  )
  const previousProtocolVersions = singleMatch(
    source,
    PREVIOUS_DECLARATION,
    'PREVIOUS_DAEMON_PROTOCOL_VERSIONS',
    label
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseProtocolInteger(entry, 'PREVIOUS_DAEMON_PROTOCOL_VERSIONS entry', label))
  if (protocolVersion > 1 && previousProtocolVersions.length === 0) {
    throw new Error(`${label}: PREVIOUS_DAEMON_PROTOCOL_VERSIONS parsed as empty`)
  }
  const outOfRange = previousProtocolVersions.filter((version) => version >= protocolVersion)
  if (outOfRange.length > 0) {
    throw new Error(
      `${label}: PREVIOUS_DAEMON_PROTOCOL_VERSIONS lists ${outOfRange.join(', ')}, not below PROTOCOL_VERSION ${protocolVersion}`
    )
  }
  return { protocolVersion, previousProtocolVersions }
}

/** Whether `reader` can route sessions owned by a daemon speaking `owner`'s protocol. */
export function canAttach(reader, owner) {
  return (
    reader.protocolVersion === owner.protocolVersion ||
    reader.previousProtocolVersions.includes(owner.protocolVersion)
  )
}

/** What any candidate must declare for sessions to cross in each direction with `release`. */
export function crossingRequirements(release) {
  const accepted = [...release.previousProtocolVersions, release.protocolVersion]
  return {
    upgrade: `candidate speaks ${release.protocolVersion} or lists ${release.protocolVersion} as previous`,
    rollback: `candidate speaks one of ${Math.min(...accepted)}..${Math.max(...accepted)} (the release's own or previous list)`,
    // Only an owner the release already speaks can survive a rollback, so a newer-protocol candidate cannot.
    bothDirections: `candidate speaks ${release.protocolVersion}, or speaks an older release-listed version and lists ${release.protocolVersion} as previous`
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  if (!input) {
    throw new Error('usage: daemon-protocol-facts.mjs <daemon-protocol-version.ts> [output.json]')
  }
  const facts = parseDaemonProtocolFacts(readFileSync(input, 'utf8'), input)
  if (output) {
    writeFileSync(output, `${JSON.stringify(facts)}\n`)
  }
  console.log(JSON.stringify(facts))
}
