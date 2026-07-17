const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+(?:\.[0-9A-Za-z]+)?)?$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const MANAGED_ASSET_PREFIX = 'orca-ssh-relay-runtime-'

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime draft recovery ${label} must be an object`)
  }
}

function normalizeAsset(value, label) {
  assertObject(value, label)
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 240) {
    throw new Error(`SSH relay runtime draft recovery ${label} has an invalid name`)
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`SSH relay runtime draft recovery ${label} has an invalid sha256`)
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error(`SSH relay runtime draft recovery ${label} has an invalid size`)
  }
  return { name: value.name, sha256: value.sha256, size: value.size }
}

function uniqueAssets(values, label) {
  if (!Array.isArray(values)) {
    throw new Error(`SSH relay runtime draft recovery ${label} must be an array`)
  }
  const names = new Set()
  return values.map((value) => {
    const asset = normalizeAsset(value, label)
    if (names.has(asset.name)) {
      throw new Error(
        `SSH relay runtime draft recovery ${label} has a duplicate asset: ${asset.name}`
      )
    }
    names.add(asset.name)
    return asset
  })
}

function sameAsset(left, right) {
  return left.name === right.name && left.sha256 === right.sha256 && left.size === right.size
}

export function planSshRelayRuntimeDraftRecovery({ tag, sourceCommit, expectedAssets, draft }) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error('SSH relay runtime draft recovery tag is invalid')
  }
  if (typeof sourceCommit !== 'string' || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('SSH relay runtime draft recovery source commit is invalid')
  }
  assertObject(draft, 'draft')
  if (draft.state !== 'draft') {
    // Why: recovery may fill an existing private draft, never alter already published bytes.
    throw new Error('SSH relay runtime release must remain draft during recovery')
  }
  if (draft.tag !== tag) {
    throw new Error('SSH relay runtime recovered draft tag does not match the requested release')
  }
  if (draft.sourceCommit !== sourceCommit) {
    throw new Error('SSH relay runtime recovered draft source commit does not match')
  }
  const expected = uniqueAssets(expectedAssets, 'expected assets')
  if (expected.some((asset) => !asset.name.startsWith(MANAGED_ASSET_PREFIX))) {
    throw new Error('SSH relay runtime draft recovery expected an unmanaged asset')
  }
  const expectedByName = new Map(expected.map((asset) => [asset.name, asset]))
  const existing = uniqueAssets(draft.assets, 'draft assets')
  const reusableNames = new Set()
  for (const asset of existing) {
    const expectedAsset = expectedByName.get(asset.name)
    if (!expectedAsset) {
      if (asset.name.startsWith(MANAGED_ASSET_PREFIX)) {
        throw new Error(`SSH relay runtime draft has an unexpected managed asset: ${asset.name}`)
      }
      continue
    }
    if (!sameAsset(asset, expectedAsset)) {
      throw new Error(`SSH relay runtime draft immutable bytes disagree: ${asset.name}`)
    }
    reusableNames.add(asset.name)
  }
  return {
    reusableAssets: expected.filter((asset) => reusableNames.has(asset.name)),
    uploadAssets: expected.filter((asset) => !reusableNames.has(asset.name))
  }
}
