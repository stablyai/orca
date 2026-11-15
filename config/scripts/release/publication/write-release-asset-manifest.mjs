#!/usr/bin/env node
// Records exactly which release assets a build job uploaded (name, size, sha256), so publishing can refuse any
// draft asset that a person replaced afterwards. Imports nothing local: build jobs restore only this file.
// Usage: node write-release-asset-manifest.mjs <out.json> <source> <file>...   (env: TAG, RELEASE_SHA)
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export const MANIFEST_SCHEMA = 'orca-release-asset-manifest/v1'
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/
export const SOURCES = ['linux-x64', 'linux-arm64', 'win', 'mac', 'orca-server']

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function buildManifest({ source, tag, releaseSha, runId, runAttempt, files }) {
  if (!SOURCES.includes(source)) {
    throw new Error(`Unknown manifest source '${source}'`)
  }
  const assets = []
  for (const file of files) {
    const name = basename(file)
    const size = statSync(file).size
    if (!ASSET_NAME.test(name) || assets.some((asset) => asset.name === name) || size === 0) {
      throw new Error(`Refusing to record ${file}: bad, duplicate or empty asset name`)
    }
    assets.push({ name, size, sha256: await sha256File(file) })
  }
  if (assets.length === 0) {
    throw new Error(`No uploaded assets to record for ${source}`)
  }
  return {
    schema: MANIFEST_SCHEMA,
    source,
    tag,
    release_sha: releaseSha,
    run_id: runId,
    run_attempt: runAttempt,
    assets
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [out, source, ...files] = process.argv.slice(2)
  const { TAG, RELEASE_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  buildManifest({
    source,
    tag: TAG,
    releaseSha: RELEASE_SHA,
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    files
  })
    .then((manifest) => {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
      for (const asset of manifest.assets) {
        console.log(`${asset.sha256}  ${asset.size}  ${asset.name}`)
      }
    })
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
