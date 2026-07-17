import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const API_VERSION = '2022-11-28'
const ASSET_HOST = 'release-assets.githubusercontent.com'
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const MANAGED_ASSET_PREFIX = 'orca-ssh-relay-runtime-'
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+(?:\.[0-9A-Za-z]+)?)?$/u
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_ASSETS = 26
const MAX_ATTEMPTS = 3
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 15 * 60_000

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime draft upload ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`SSH relay runtime draft upload ${label} has unexpected or missing fields`)
  }
}

function authenticatedHeaders(accept = 'application/vnd.github+json', token) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION
  }
}

async function responseError(response) {
  const body = await response.text().catch(() => '')
  return new Error(
    `SSH relay runtime GitHub upload request failed ${response.status} ${response.statusText}: ${body.slice(0, 300)}`
  )
}

function normalizeInputs({ repo, releaseId, tag, sourceCommit, token, assets }) {
  if (typeof repo !== 'string' || !REPOSITORY_PATTERN.test(repo)) {
    throw new Error('SSH relay runtime draft upload repository is invalid')
  }
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error('SSH relay runtime draft upload release ID is invalid')
  }
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error('SSH relay runtime draft upload tag is invalid')
  }
  if (typeof sourceCommit !== 'string' || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('SSH relay runtime draft upload source commit is invalid')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('SSH relay runtime draft upload token is required')
  }
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_ASSETS) {
    throw new Error('SSH relay runtime draft upload assets must be a bounded non-empty array')
  }
  const names = new Set()
  let totalBytes = 0
  const normalizedAssets = assets.map((asset, index) => {
    assertExactFields(asset, ['name', 'path', 'sha256', 'size'], `asset ${index}`)
    if (
      typeof asset.name !== 'string' ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      !asset.name.startsWith(MANAGED_ASSET_PREFIX) ||
      names.has(asset.name)
    ) {
      throw new Error('SSH relay runtime draft upload asset has an invalid or duplicate name')
    }
    names.add(asset.name)
    if (typeof asset.path !== 'string' || asset.path.length === 0) {
      throw new Error(`SSH relay runtime draft upload asset path is invalid: ${asset.name}`)
    }
    if (typeof asset.sha256 !== 'string' || !DIGEST_PATTERN.test(asset.sha256)) {
      throw new Error(`SSH relay runtime draft upload asset SHA-256 is invalid: ${asset.name}`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
      throw new Error(`SSH relay runtime draft upload asset size is invalid: ${asset.name}`)
    }
    totalBytes += asset.size
    return { ...asset }
  })
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('SSH relay runtime draft upload assets exceed the total size limit')
  }
  return { repo, releaseId, tag, sourceCommit, token, assets: normalizedAssets }
}

async function verifyLocalAsset(asset, signal) {
  signal.throwIfAborted()
  const metadata = await lstat(asset.path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `SSH relay runtime draft upload local asset must be a regular file: ${asset.name}`
    )
  }
  if (metadata.size !== asset.size) {
    throw new Error(`SSH relay runtime draft upload local asset size disagrees: ${asset.name}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(asset.path)) {
    signal.throwIfAborted()
    hash.update(chunk)
  }
  if (`sha256:${hash.digest('hex')}` !== asset.sha256) {
    throw new Error(`SSH relay runtime draft upload local asset SHA-256 disagrees: ${asset.name}`)
  }
}

function validateDraft(release, expected, { releaseId, tag }) {
  assertObject(release, 'release')
  if (release.id !== releaseId || release.draft !== true) {
    throw new Error('SSH relay runtime release must remain the requested draft during upload')
  }
  if (release.tag_name !== tag) {
    throw new Error('SSH relay runtime draft upload tag does not match')
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('SSH relay runtime draft upload release assets must be an array')
  }
  const expectedNames = new Set(expected.map((asset) => asset.name))
  const existing = new Map()
  for (const asset of release.assets) {
    assertObject(asset, 'release asset')
    if (typeof asset.name !== 'string' || existing.has(asset.name)) {
      throw new Error('SSH relay runtime draft upload has a duplicate or invalid release asset')
    }
    existing.set(asset.name, asset)
    if (asset.name.startsWith(MANAGED_ASSET_PREFIX) && !expectedNames.has(asset.name)) {
      throw new Error(`SSH relay runtime draft has an unexpected managed asset: ${asset.name}`)
    }
  }
  return existing
}

async function fetchJson(context, url, signal) {
  const response = await context.fetchImpl(url, {
    headers: authenticatedHeaders(undefined, context.token),
    redirect: 'error',
    signal
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json()
}

async function resolveTagCommit(context, signal) {
  const reference = await fetchJson(
    context,
    `https://api.github.com/repos/${context.repo}/git/ref/tags/${encodeURIComponent(context.tag)}`,
    signal
  )
  let object = reference?.object
  const seen = new Set()
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      !object ||
      typeof object !== 'object' ||
      typeof object.sha !== 'string' ||
      !COMMIT_PATTERN.test(object.sha) ||
      (object.type !== 'commit' && object.type !== 'tag') ||
      seen.has(object.sha)
    ) {
      throw new Error('SSH relay runtime draft upload tag reference is invalid')
    }
    if (object.type === 'commit') {
      return object.sha
    }
    seen.add(object.sha)
    const tag = await fetchJson(
      context,
      `https://api.github.com/repos/${context.repo}/git/tags/${object.sha}`,
      signal
    )
    object = tag?.object
  }
  throw new Error('SSH relay runtime draft upload annotated tag depth exceeded')
}

async function fetchDraft(context, signal) {
  const release = await fetchJson(
    context,
    `https://api.github.com/repos/${context.repo}/releases/${context.releaseId}`,
    signal
  )
  const existing = validateDraft(release, context.assets, context)
  if ((await resolveTagCommit(context, signal)) !== context.sourceCommit) {
    throw new Error('SSH relay runtime draft upload source commit does not match the tag')
  }
  return existing
}

async function fetchExistingAsset(context, remote, signal) {
  if (
    !Number.isSafeInteger(remote.id) ||
    remote.id <= 0 ||
    remote.state !== 'uploaded' ||
    !Number.isSafeInteger(remote.size)
  ) {
    throw new Error(`SSH relay runtime draft upload has invalid asset metadata: ${remote.name}`)
  }
  let response = await context.fetchImpl(
    `https://api.github.com/repos/${context.repo}/releases/assets/${remote.id}`,
    {
      headers: authenticatedHeaders('application/octet-stream', context.token),
      redirect: 'manual',
      signal
    }
  )
  if (response.status === 302) {
    const location = response.headers.get('location')
    const url = location ? new URL(location) : null
    if (!url || url.protocol !== 'https:' || url.hostname !== ASSET_HOST) {
      throw new Error('SSH relay runtime draft upload asset redirect is invalid')
    }
    // Why: authenticated API headers must never be forwarded to the signed asset CDN URL.
    response = await context.fetchImpl(url.href, {
      headers: { Accept: 'application/octet-stream' },
      redirect: 'error',
      signal
    })
  }
  if (response.status !== 200 || !response.body) {
    throw await responseError(response)
  }
  return response
}

async function verifyExistingAsset(context, expected, remote, signal) {
  if (remote.size !== expected.size) {
    throw new Error(
      `SSH relay runtime draft upload existing asset size disagrees: ${expected.name}`
    )
  }
  const response = await fetchExistingAsset(context, remote, signal)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > expected.size || size > MAX_ASSET_BYTES) {
      throw new Error(
        `SSH relay runtime draft upload existing asset size exceeded: ${expected.name}`
      )
    }
    hash.update(bytes)
  }
  if (size !== expected.size) {
    throw new Error(
      `SSH relay runtime draft upload existing asset size disagrees: ${expected.name}`
    )
  }
  if (`sha256:${hash.digest('hex')}` !== expected.sha256) {
    throw new Error(
      `SSH relay runtime draft upload existing asset SHA-256 disagrees: ${expected.name}`
    )
  }
}

async function reconcileDraft(context, signal) {
  const remoteByName = await fetchDraft(context, signal)
  const reusable = new Set()
  for (const expected of context.assets) {
    const remote = remoteByName.get(expected.name)
    if (remote) {
      await verifyExistingAsset(context, expected, remote, signal)
      reusable.add(expected.name)
    }
  }
  return reusable
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

async function defaultDelay(milliseconds, signal) {
  await delay(milliseconds, undefined, { signal })
}

async function uploadAsset(context, asset, signal, delayImpl) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await verifyLocalAsset(asset, signal)
    let failure
    let response
    const body = createReadStream(asset.path)
    let bodyFailure
    const bodyClosed = new Promise((resolve) => {
      body.once('error', (error) => {
        bodyFailure = error
      })
      body.once('close', resolve)
    })
    try {
      response = await context.fetchImpl(
        `https://uploads.github.com/repos/${context.repo}/releases/${context.releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        {
          method: 'POST',
          headers: {
            ...authenticatedHeaders('application/vnd.github+json', context.token),
            'Content-Length': String(asset.size),
            'Content-Type': 'application/octet-stream'
          },
          body,
          duplex: 'half',
          redirect: 'error',
          signal
        }
      )
    } catch (error) {
      signal.throwIfAborted()
      failure = error
    } finally {
      // Why: injected failures and early HTTP responses may not consume the request stream.
      body.destroy()
      await bodyClosed
    }
    if (bodyFailure) {
      throw new Error(`SSH relay runtime draft upload local asset stream failed: ${asset.name}`, {
        cause: bodyFailure
      })
    }
    if (response?.status === 201) {
      const result = await response.json()
      if (
        result.name !== asset.name ||
        result.state !== 'uploaded' ||
        result.size !== asset.size ||
        !Number.isSafeInteger(result.id) ||
        result.id <= 0
      ) {
        throw new Error(`SSH relay runtime draft upload returned invalid metadata: ${asset.name}`)
      }
      return 'uploaded'
    }
    if (response) {
      failure = await responseError(response)
      if (!retryableStatus(response.status)) {
        throw failure
      }
    }

    // Why: a lost POST response may still have created the asset; reconcile before any retry.
    const reusable = await reconcileDraft(context, signal)
    if (reusable.has(asset.name)) {
      return 'reused'
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`SSH relay runtime draft upload retry exhaustion: ${asset.name}`, {
        cause: failure
      })
    }
    await delayImpl(2 ** (attempt - 1) * 1_000, signal)
  }
  throw new Error(`SSH relay runtime draft upload retry exhaustion: ${asset.name}`)
}

export async function uploadSshRelayRuntimeDraftAssets({
  repo,
  releaseId,
  tag,
  sourceCommit,
  token,
  assets,
  fetchImpl = fetch,
  delayImpl = defaultDelay,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
    : AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  const context = {
    ...normalizeInputs({ repo, releaseId, tag, sourceCommit, token, assets }),
    fetchImpl
  }
  for (const asset of context.assets) {
    await verifyLocalAsset(asset, effectiveSignal)
  }
  const initiallyReusable = await reconcileDraft(context, effectiveSignal)
  const reusedAssets = []
  const uploadedAssets = []
  for (const asset of context.assets) {
    const identity = { name: asset.name, sha256: asset.sha256, size: asset.size }
    if (initiallyReusable.has(asset.name)) {
      reusedAssets.push(identity)
      continue
    }
    const outcome = await uploadAsset(context, asset, effectiveSignal, delayImpl)
    const recordedAssets = outcome === 'reused' ? reusedAssets : uploadedAssets
    recordedAssets.push(identity)
  }
  return { releaseId, tag, sourceCommit, reusedAssets, uploadedAssets }
}
