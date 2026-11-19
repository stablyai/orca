// Publish the Codex history cleanup policy apps download, checked by the app's own parser.
// Usage: publish-next | promote-stable | emergency-off.

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
const CLEANUP_PLATFORMS = ['darwin', 'win32']
// The kinds the app reads, from the app, so a kind added later is covered by emergency-off.
const KINDS = Object.keys(codexHistoryCleanupThresholds(null))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseOrThrow(bytes, what) {
  const parsed = parseCodexHistoryCleanupPolicy(bytes.toString('utf8'))
  if (!parsed.ok) {
    throw new Error(`apps would reject ${what}: ${parsed.error}`)
  }
  return parsed.policy
}

/** Parses as apps do, then refuses any field their per-field fallbacks would silently replace. */
export function validatedCodexHistoryCleanupPolicy(bytes) {
  const policy = parseOrThrow(bytes, 'this policy')
  const raw = JSON.parse(bytes.toString('utf8'))
  const thresholds = codexHistoryCleanupThresholds(policy)
  for (const [kind, rule] of Object.entries(raw.kinds ?? {})) {
    const read = KINDS.includes(kind) ? policy.kinds[kind] : undefined
    if (!read) {
      throw new Error(`kinds.${kind} is not a kind apps read`)
    }
    if (read.mode !== rule.mode) {
      throw new Error(`kinds.${kind}.mode ${JSON.stringify(rule.mode)} reads as ${read.mode}`)
    }
    const permille = rule.enforcePermille
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

function publishedPolicy(gh, repo, tag) {
  const bytes = downloadChannelAsset({ gh, repo, tag, asset: ASSET })
  return bytes === null ? null : { bytes, policy: parseOrThrow(bytes, `the ${tag} file`) }
}

/** Puts `bytes` on the channel's release and reads them back, so apps get exactly these bytes. */
export function publishCodexHistoryCleanupPolicy({ repo, channel, bytes, target, gh = runGh }) {
  const policy = validatedCodexHistoryCleanupPolicy(bytes)
  const tag = codexHistoryCleanupPolicyTag(channel)
  const published = publishedPolicy(gh, repo, tag)
  // Apps keep the higher revision they have, so an equal or lower one would never arrive.
  if (published && policy.revision <= published.policy.revision) {
    throw new Error(
      `revision ${policy.revision} is not higher than the published ${published.policy.revision}; bump it in ${POLICY_FILE}`
    )
  }
  putChannelAsset({
    gh,
    repo,
    tag,
    asset: ASSET,
    bytes,
    exists: published !== null,
    target,
    title: `Codex history cleanup policy (${channel})`,
    notes:
      'Codex history cleanup policy for Orca. Running apps download this file; it is not an app release.'
  })
  const uploaded = downloadChannelAsset({ gh, repo, tag, asset: ASSET })
  if (uploaded === null || sha256(uploaded) !== sha256(bytes)) {
    throw new Error(`${tag} does not hold the uploaded bytes (sha256 ${sha256(bytes)})`)
  }
  return { tag, revision: policy.revision, sha256: sha256(bytes) }
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

/**
 * Every kind `off`, above any published revision, on next and then stable with no soak: apps obey
 * an `off` from any revision they know. Lifting it takes a checked-in revision above this one.
 */
export function publishCodexHistoryCleanupOff({ repo, target, text, gh = runGh }) {
  const raw = JSON.parse(text)
  const published = ['next', 'stable'].map(
    (channel) => publishedPolicy(gh, repo, codexHistoryCleanupPolicyTag(channel))?.policy.revision
  )
  raw.revision = Math.max(0, ...published.filter((revision) => revision !== undefined)) + 1
  raw.kinds = Object.fromEntries(
    KINDS.map((kind) => [kind, { enforcePermille: 0, ...raw.kinds?.[kind], mode: 'off' }])
  )
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`)
  const next = publishCodexHistoryCleanupPolicy({ repo, channel: 'next', bytes, target, gh })
  return [next, promoteCodexHistoryCleanupPolicy({ repo, target, gh })]
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

function main([command]) {
  const repo = requireEnv('GITHUB_REPOSITORY')
  const target = requireEnv('GITHUB_SHA')
  const file = readFileSync(join(import.meta.dirname, '../../../..', POLICY_FILE))
  const results =
    command === 'publish-next'
      ? [publishCodexHistoryCleanupPolicy({ repo, channel: 'next', bytes: file, target })]
      : command === 'promote-stable'
        ? [promoteCodexHistoryCleanupPolicy({ repo, target })]
        : command === 'emergency-off'
          ? publishCodexHistoryCleanupOff({ repo, target, text: file.toString('utf8') })
          : null
  if (!results) {
    throw new Error(`unknown command ${command ?? '(none)'}`)
  }
  for (const { tag, revision, sha256: hash } of results) {
    console.log(`Published revision ${revision} to ${tag} (sha256 ${hash}).`)
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
