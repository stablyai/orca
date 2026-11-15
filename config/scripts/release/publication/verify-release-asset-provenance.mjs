#!/usr/bin/env node
// Anyone with contents write can replace a draft asset, so the draft must equal, by GitHub's sha256 digest, the
// manifests this release's builds wrote. Manifests are untrusted data, read strictly from expected locations only.
// Usage: node verify-release-asset-provenance.mjs <this-run-manifests-dir> <mac-manifest-dir>
//   env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, TAG, RELEASE_SHA, MAC_RUN_ID, ORCA_SERVER ('true' when uploaded)
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  fetchRelease,
  getRequiredReleaseAssetNames,
  githubFetch
} from './verify-release-required-assets.mjs'
import { ASSET_NAME, MANIFEST_SCHEMA, SOURCES } from './write-release-asset-manifest.mjs'

const API = 'https://api.github.com'
const RUN_ID = /^[1-9][0-9]{0,19}$/
const MAX_MANIFEST_BYTES = 64 * 1024
const KEYS = ['schema', 'source', 'tag', 'release_sha', 'run_id', 'run_attempt', 'assets']

const sameKeys = (value, keys) =>
  JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort())

export function parseManifest(text, expected) {
  const manifest = JSON.parse(text)
  const fail = (what) => {
    throw new Error(`${expected.source} manifest ${what}`)
  }
  if (!sameKeys(manifest, KEYS)) fail('has unexpected fields')
  for (const key of ['schema', 'source', 'tag', 'release_sha', 'run_id']) {
    const want = key === 'schema' ? MANIFEST_SCHEMA : expected[key]
    if (manifest[key] !== want) fail(`${key} is '${manifest[key]}', expected '${want}'`)
  }
  // Why: the Windows job uploads only on attempt 1 (reruns reuse those signed assets), so its manifest must be too.
  const attempt = manifest.run_attempt
  if (!RUN_ID.test(attempt) || (expected.firstAttempt && attempt !== '1')) {
    fail(`run_attempt '${attempt}' is not allowed`)
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : []
  if (assets.length === 0 || assets.length > 50) fail('has no asset list')
  for (const asset of assets) {
    const ok =
      sameKeys(asset, ['name', 'sha256', 'size']) &&
      typeof asset.name === 'string' &&
      ASSET_NAME.test(asset.name) &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      /^[0-9a-f]{64}$/.test(asset.sha256)
    if (!ok) fail('has a malformed asset entry')
  }
  return manifest
}

// Reads <dir>/manifest.json only when dir holds exactly that one regular file: no links, folders or extra files.
export function readManifestDir(dir) {
  const entries = readdirSync(dir)
  const file = join(dir, 'manifest.json')
  const stat = entries.length === 1 && entries[0] === 'manifest.json' ? lstatSync(file) : null
  if (!stat?.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${dir} must contain only a small regular manifest.json`)
  }
  return readFileSync(file, 'utf8')
}

// Every expected artifact must be present, as a real directory, and nothing else.
export function readRunManifests(dir, sources) {
  const expected = new Map(sources.map((source) => [`release-asset-manifest-${source}`, source]))
  const texts = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!expected.has(entry.name) || !entry.isDirectory()) {
      throw new Error(`Unexpected manifest artifact '${entry.name}'`)
    }
    texts.set(expected.get(entry.name), readManifestDir(join(dir, entry.name)))
  }
  const missing = sources.filter((source) => !texts.has(source))
  if (missing.length > 0) {
    throw new Error(`Missing release asset manifests: ${missing.join(', ')}`)
  }
  return texts
}

// The mac assets come from a separate run; trust its manifest only from the release-mac-build.yml run on main
// that this release run dispatched for this tag.
export function assertMacRun(run, { repo, tag, releaseRunId, macRunId }) {
  const ok =
    String(run?.id) === macRunId &&
    run.path === '.github/workflows/release-mac-build.yml' &&
    run.head_branch === 'main' &&
    run.event === 'workflow_dispatch' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.display_title === `Mac release build ${tag} (${releaseRunId})`
  if (!ok) {
    throw new Error(
      `Run ${macRunId} is not the successful release-mac-build.yml run on main for ${tag}`
    )
  }
}

export async function verifyAssetProvenance({ tag, assets, manifests, hashAsset }) {
  const recorded = new Map()
  const problems = []
  for (const manifest of manifests) {
    for (const entry of manifest.assets) {
      if (recorded.has(entry.name)) {
        problems.push(`duplicate manifest entry ${entry.name}`)
      }
      recorded.set(entry.name, entry)
    }
  }
  const onDraft = new Set()
  for (const asset of assets) {
    const entry = recorded.get(asset.name)
    if (onDraft.has(asset.name)) {
      problems.push(`duplicate draft asset ${asset.name}`)
    }
    onDraft.add(asset.name)
    if (!entry) {
      problems.push(`asset ${asset.name} is not in any build manifest`)
      continue
    }
    if (asset.state !== 'uploaded' || asset.size !== entry.size) {
      problems.push(
        `asset ${asset.name} is ${asset.state}, ${asset.size} bytes; built ${entry.size}`
      )
      continue
    }
    // GitHub computes digest on upload; older assets may lack it, so hash those bytes ourselves.
    const actual =
      asset.digest == null ? `sha256:${await hashAsset(asset)}` : String(asset.digest).toLowerCase()
    if (actual !== `sha256:${entry.sha256}`) {
      problems.push(
        `asset ${asset.name} digest ${actual} does not match built sha256:${entry.sha256}`
      )
    }
  }
  for (const name of new Set([...recorded.keys(), ...getRequiredReleaseAssetNames(tag)])) {
    if (!onDraft.has(name)) {
      problems.push(`asset ${name} is missing from the draft`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Release ${tag} assets do not match their build manifests:\n${problems.join('\n')}`
    )
  }
  return [...onDraft].sort()
}

export function hashReleaseAsset(repo, token) {
  return async (asset) => {
    const url = `${API}/repos/${repo}/releases/assets/${asset.id}`
    const res = await githubFetch(url, token, 'application/octet-stream')
    const hash = createHash('sha256')
    for await (const chunk of res.body) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  }
}

async function main([runDir, macDir]) {
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, TAG: tag } = process.env
  const { RELEASE_SHA: releaseSha, MAC_RUN_ID: macRunId, ORCA_SERVER: orcaServer } = process.env
  if (!token || !repo || !RUN_ID.test(`${runId}`) || !RUN_ID.test(`${macRunId}`) || !macDir) {
    throw new Error('Usage: verify-release-asset-provenance.mjs <run-dir> <mac-dir> (see header)')
  }
  const run = await (
    await githubFetch(`${API}/repos/${repo}/actions/runs/${macRunId}`, token)
  ).json()
  assertMacRun(run, { repo, tag, releaseRunId: runId, macRunId })
  const sources = SOURCES.filter(
    (s) => s !== 'mac' && (s !== 'orca-server' || orcaServer === 'true')
  )
  const common = { tag, release_sha: releaseSha }
  const manifests = [...readRunManifests(runDir, sources)].map(([source, text]) =>
    parseManifest(text, { ...common, source, run_id: runId, firstAttempt: source === 'win' })
  )
  manifests.push(
    parseManifest(readManifestDir(macDir), { ...common, source: 'mac', run_id: macRunId })
  )
  const release = await fetchRelease(repo, tag, token)
  if (release.draft !== true) {
    throw new Error(`Release ${tag} is not a draft in the releases list`)
  }
  const names = await verifyAssetProvenance({
    tag,
    assets: release.assets,
    manifests,
    hashAsset: hashReleaseAsset(repo, token)
  })
  console.log(
    `Verified ${names.length} assets of ${tag} against ${manifests.length} build manifests`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message.split('\n')[0]}`)
    console.error(error.message)
    process.exit(1)
  })
}
