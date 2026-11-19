// Publish the Codex history cleanup policy apps download, checked by the app's own parser.
// Usage: validate | publish-next | promote-stable | emergency-off [--revision <n>].

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  codexHistoryCleanupThresholds,
  parseCodexHistoryCleanupPolicy
} from '../../../../src/main/codex/history/cleanup-policy/codex-history-cleanup-policy.ts'
import {
  downloadChannelAsset,
  putChannelAsset,
  runGh
} from '../publication/channel-release-asset.mjs'
import { codexHistoryCleanupPolicyTag } from '../versioning/release-tag-patterns.mjs'

const POLICY_FILE = 'config/remote-policies/codex-history-cleanup-policy.json'
const ASSET = 'codex-history-cleanup-policy.json'
const CHANNELS = ['next', 'stable']
const CLEANUP_PLATFORMS = ['darwin', 'win32']
const POLICY_KEYS = ['version', 'revision', 'kinds']
const RULE_KEYS = ['mode', 'enforcePermille', 'platforms', 'thresholds']
// The kinds the app reads, from the app, so a kind added later is covered by emergency-off.
const KINDS = Object.keys(codexHistoryCleanupThresholds(null))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Apps ignore unknown keys, so a typo like `platform` would silently widen enforce.
function requireKnownKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${where} has unknown keys: ${unknown.join(', ')}`)
  }
}

/** Parses as apps do, then refuses anything their per-field fallbacks would silently replace. */
export function validatedCodexHistoryCleanupPolicy(bytes) {
  const parsed = parseCodexHistoryCleanupPolicy(bytes.toString('utf8'))
  if (!parsed.ok) {
    throw new Error(`apps would reject this policy: ${parsed.error}`)
  }
  const { policy } = parsed
  const raw = JSON.parse(bytes.toString('utf8'))
  requireKnownKeys(raw, POLICY_KEYS, 'the policy')
  if (!isPlainObject(raw.kinds)) {
    throw new Error('kinds must be an object')
  }
  const thresholds = codexHistoryCleanupThresholds(policy)
  for (const [kind, rule] of Object.entries(raw.kinds)) {
    const read = KINDS.includes(kind) ? policy.kinds[kind] : undefined
    if (!read || !isPlainObject(rule)) {
      throw new Error(`kinds.${kind} is not a kind apps read`)
    }
    requireKnownKeys(rule, RULE_KEYS, `kinds.${kind}`)
    if (read.mode !== rule.mode) {
      throw new Error(`kinds.${kind}.mode ${JSON.stringify(rule.mode)} reads as ${read.mode}`)
    }
    const permille = rule.enforcePermille ?? 0
    if (!Number.isInteger(permille) || permille < 0 || permille > 1000) {
      throw new Error(`kinds.${kind}.enforcePermille must be an integer from 0 to 1000`)
    }
    if (
      rule.platforms !== undefined &&
      (!Array.isArray(rule.platforms) ||
        !rule.platforms.every((platform) => CLEANUP_PLATFORMS.includes(platform)))
    ) {
      throw new Error(`kinds.${kind}.platforms may list only ${CLEANUP_PLATFORMS.join(', ')}`)
    }
    if (rule.thresholds !== undefined && !isPlainObject(rule.thresholds)) {
      throw new Error(`kinds.${kind}.thresholds must be an object`)
    }
    for (const [name, value] of Object.entries(rule.thresholds ?? {})) {
      if (thresholds[kind][name] !== value) {
        throw new Error(
          `kinds.${kind}.thresholds.${name} ${value} reads as ${thresholds[kind][name] ?? '(unknown)'}`
        )
      }
    }
  }
  return policy
}

/**
 * What `tag` holds: `exists` false when there is no release. With `lenient`, a missing asset or
 * unreadable file gives a null revision instead of throwing.
 */
function readChannel(gh, repo, tag, { lenient = false } = {}) {
  let bytes
  try {
    bytes = downloadChannelAsset({ gh, repo, tag, asset: ASSET })
  } catch (error) {
    if (!lenient) {
      throw error
    }
    return { exists: true, bytes: null, revision: null }
  }
  if (bytes === null) {
    return { exists: false, bytes: null, revision: null }
  }
  const parsed = parseCodexHistoryCleanupPolicy(bytes.toString('utf8'))
  if (!parsed.ok && !lenient) {
    throw new Error(`apps would reject the ${tag} file: ${parsed.error}`)
  }
  return { exists: true, bytes, revision: parsed.ok ? parsed.policy.revision : null }
}

/**
 * Puts `bytes` on the channel's release and reads them back, so apps get exactly these bytes.
 * The same bytes already there count as published, so a rerun after a partial failure succeeds.
 */
export function publishCodexHistoryCleanupPolicy({
  repo,
  channel,
  bytes,
  target,
  gh = runGh,
  lenient = false
}) {
  const policy = validatedCodexHistoryCleanupPolicy(bytes)
  const tag = codexHistoryCleanupPolicyTag(channel)
  const result = { tag, revision: policy.revision, sha256: sha256(bytes) }
  const published = readChannel(gh, repo, tag, { lenient })
  if (published.revision !== null) {
    if (published.revision === policy.revision && sha256(published.bytes) === result.sha256) {
      return { ...result, unchanged: true }
    }
    // Apps keep the higher revision they have, so an equal or lower one would never arrive.
    if (policy.revision <= published.revision) {
      throw new Error(
        `revision ${policy.revision} is not higher than the published ${published.revision}; bump it in ${POLICY_FILE}`
      )
    }
  }
  putChannelAsset({
    gh,
    repo,
    tag,
    asset: ASSET,
    bytes,
    exists: published.exists,
    target,
    title: `Codex history cleanup policy (${channel})`,
    notes:
      'Codex history cleanup policy for Orca. Running apps download this file; it is not an app release.'
  })
  const uploaded = downloadChannelAsset({ gh, repo, tag, asset: ASSET })
  if (uploaded === null || sha256(uploaded) !== result.sha256) {
    throw new Error(`${tag} does not hold the uploaded bytes (sha256 ${result.sha256})`)
  }
  return result
}

/** Copies next's exact bytes to stable, no rebuild. */
export function promoteCodexHistoryCleanupPolicy({ repo, target, gh = runGh }) {
  const nextTag = codexHistoryCleanupPolicyTag('next')
  const bytes = downloadChannelAsset({ gh, repo, tag: nextTag, asset: ASSET })
  if (bytes === null) {
    throw new Error(`${nextTag} has not been published`)
  }
  return publishCodexHistoryCleanupPolicy({ repo, channel: 'stable', bytes, target, gh })
}

function checkedInRevision(fileText) {
  try {
    const revision = JSON.parse(fileText).revision
    return Number.isInteger(revision) ? revision : 0
  } catch {
    return 0
  }
}

/**
 * Every kind `off`, built from scratch above every published and checked-in revision, on each
 * channel independently with no soak: apps obey an `off` from any revision they know. Lifting it
 * takes a checked-in revision above this one.
 */
export function publishCodexHistoryCleanupOff({
  repo,
  target,
  fileText,
  minRevision = 0,
  gh = runGh
}) {
  const channels = CHANNELS.map((channel) => ({
    channel,
    ...readChannel(gh, repo, codexHistoryCleanupPolicyTag(channel), { lenient: true })
  }))
  const unknown = channels.filter(({ exists, revision }) => exists && revision === null)
  const revision = Math.max(
    minRevision,
    Math.max(checkedInRevision(fileText), ...channels.map((channel) => channel.revision ?? 0)) + 1
  )
  const warnings = unknown.map(
    ({ channel }) =>
      `the ${channel} revision is unreadable; if apps may hold a revision above ${revision - 1}, rerun with a higher revision`
  )
  const policy = {
    version: 1,
    revision,
    kinds: Object.fromEntries(KINDS.map((kind) => [kind, { mode: 'off' }]))
  }
  const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`)
  const results = []
  const failures = []
  // One channel's failure must not keep the switch off the other.
  for (const { channel } of channels) {
    try {
      results.push(
        publishCodexHistoryCleanupPolicy({ repo, channel, bytes, target, gh, lenient: true })
      )
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { results, failures, warnings }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

function parseMinRevision(args) {
  const index = args.indexOf('--revision')
  if (index === -1 || !args[index + 1]) {
    return 0
  }
  const revision = Number(args[index + 1])
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error(`--revision must be a positive integer, got ${args[index + 1]}`)
  }
  return revision
}

function main([command, ...args]) {
  const file = readFileSync(join(import.meta.dirname, '../../../..', POLICY_FILE))
  if (command === 'validate') {
    const { revision } = validatedCodexHistoryCleanupPolicy(file)
    console.log(`${POLICY_FILE} is valid at revision ${revision}.`)
    return
  }
  const repo = requireEnv('GITHUB_REPOSITORY')
  const target = requireEnv('GITHUB_SHA')
  let results
  let failures = []
  if (command === 'publish-next') {
    results = [publishCodexHistoryCleanupPolicy({ repo, channel: 'next', bytes: file, target })]
  } else if (command === 'promote-stable') {
    results = [promoteCodexHistoryCleanupPolicy({ repo, target })]
  } else if (command === 'emergency-off') {
    const off = publishCodexHistoryCleanupOff({
      repo,
      target,
      fileText: file.toString('utf8'),
      minRevision: parseMinRevision(args)
    })
    for (const warning of off.warnings) {
      console.log(`::warning::${warning}`)
    }
    ;({ results, failures } = off)
  } else {
    throw new Error(`unknown command ${command ?? '(none)'}`)
  }
  for (const { tag, revision, sha256: hash, unchanged } of results) {
    console.log(
      `${unchanged ? 'Already published' : 'Published'} revision ${revision} to ${tag} (sha256 ${hash}).`
    )
  }
  if (failures.length > 0) {
    throw new Error(`not published on ${failures.join('; ')}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
