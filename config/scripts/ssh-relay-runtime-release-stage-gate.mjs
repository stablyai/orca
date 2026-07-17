import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const SUCCESS_FIELDS = ['id', 'outcome', 'attempts', 'elapsedMs', 'output']
const OUTCOMES = new Set(['success', 'failed', 'timed-out', 'cancelled', 'retry-exhausted'])

// Why: these mirror current release ceilings, but signing is single-attempt so approval cannot
// accidentally authorize a second set of bytes after a timeout or service failure.
export const SSH_RELAY_RUNTIME_RELEASE_LIMITS = Object.freeze({
  build: Object.freeze({ maxAttempts: 3, timeoutMs: 30 * 60_000 }),
  sign: Object.freeze({ maxAttempts: 1, timeoutMs: 4 * 60 * 60_000 }),
  aggregate: Object.freeze({ maxAttempts: 1, timeoutMs: 15 * 60_000 }),
  upload: Object.freeze({ maxAttempts: 3, timeoutMs: 15 * 60_000 }),
  readback: Object.freeze({ maxAttempts: 3, timeoutMs: 15 * 60_000 })
})

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime release ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime release ${label} has unexpected or missing fields`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`SSH relay runtime release ${label} must be a lowercase sha256 identity`)
  }
}

function assertAssetName(value, label) {
  if (typeof value !== 'string' || !ASSET_NAME_PATTERN.test(value)) {
    throw new Error(`SSH relay runtime release ${label} has an invalid asset name`)
  }
}

function assertSize(value, label, maximum = MAX_ARCHIVE_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`SSH relay runtime release ${label} has an invalid size`)
  }
}

function normalizeRuntimeAsset(value, tupleId, label) {
  assertExactFields(value, ['tupleId', 'name', 'sha256', 'contentId', 'size'], label)
  if (value.tupleId !== tupleId) {
    throw new Error(`SSH relay runtime release ${label} has the wrong tuple`)
  }
  assertAssetName(value.name, label)
  assertSha256(value.sha256, `${label} sha256`)
  assertSha256(value.contentId, `${label} content ID`)
  assertSize(value.size, label)
  return { ...value }
}

function normalizeReleaseFile(value, expectedName, label, maximum) {
  assertExactFields(value, ['name', 'sha256', 'size'], label)
  if (value.name !== expectedName) {
    throw new Error(`SSH relay runtime release ${label} has an unexpected name`)
  }
  assertSha256(value.sha256, `${label} sha256`)
  assertSize(value.size, label, maximum)
  return { ...value }
}

function stageKind(id) {
  if (id.startsWith('build:')) {
    return 'build'
  }
  if (id.startsWith('sign:')) {
    return 'sign'
  }
  return id
}

function failureMessage(stage) {
  if (stage.outcome === 'timed-out') {
    return `${stage.id} timed out`
  }
  if (stage.outcome === 'retry-exhausted') {
    return `${stage.id} reached retry exhaustion`
  }
  return `${stage.id} ${stage.outcome}`
}

function normalizeSuccessfulStage(stage) {
  assertExactFields(stage, SUCCESS_FIELDS, 'stage result')
  if (typeof stage.id !== 'string' || stage.id.length === 0) {
    throw new Error('SSH relay runtime release stage ID is invalid')
  }
  if (!OUTCOMES.has(stage.outcome)) {
    throw new Error(`SSH relay runtime release ${stage.id} has an unknown outcome`)
  }
  const limits = SSH_RELAY_RUNTIME_RELEASE_LIMITS[stageKind(stage.id)]
  if (!limits) {
    throw new Error(`SSH relay runtime release has an unexpected stage: ${stage.id}`)
  }
  if (
    !Number.isSafeInteger(stage.attempts) ||
    stage.attempts < 1 ||
    stage.attempts > limits.maxAttempts
  ) {
    throw new Error(`SSH relay runtime release ${stage.id} exceeds its attempt budget`)
  }
  if (
    !Number.isSafeInteger(stage.elapsedMs) ||
    stage.elapsedMs < 0 ||
    stage.elapsedMs > limits.timeoutMs
  ) {
    throw new Error(`SSH relay runtime release ${stage.id} exceeds its time budget`)
  }
  if (stage.outcome !== 'success') {
    throw new Error(`SSH relay runtime release ${failureMessage(stage)}`)
  }
  return stage
}

function normalizeTupleIds(tupleIds, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(tupleIds) || (!allowEmpty && tupleIds.length === 0)) {
    throw new Error(
      `SSH relay runtime release ${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`
    )
  }
  const seen = new Set()
  return tupleIds.map((tupleId) => {
    if (!Object.hasOwn(sshRelayRuntimeCompatibility, tupleId)) {
      throw new Error(`SSH relay runtime release ${label} contains an unknown tuple: ${tupleId}`)
    }
    if (seen.has(tupleId)) {
      throw new Error(`SSH relay runtime release ${label} contains a duplicate tuple: ${tupleId}`)
    }
    seen.add(tupleId)
    return tupleId
  })
}

function sameAssets(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function assertAssetChain(actual, expected, label) {
  if (!Array.isArray(actual) || !sameAssets(actual, expected)) {
    throw new Error(
      `SSH relay runtime release ${label} assets disagree with prior immutable output`
    )
  }
}

function collectStages(stages, expectedIds) {
  if (!Array.isArray(stages)) {
    throw new Error('SSH relay runtime release stages must be an array')
  }
  const expected = new Set(expectedIds)
  const byId = new Map()
  for (const stage of stages) {
    assertObject(stage, 'stage result')
    if (typeof stage.id !== 'string' || !expected.has(stage.id)) {
      throw new Error(`SSH relay runtime release has an unexpected stage: ${String(stage.id)}`)
    }
    if (byId.has(stage.id)) {
      throw new Error(`SSH relay runtime release has a duplicate stage: ${stage.id}`)
    }
    byId.set(stage.id, normalizeSuccessfulStage(stage))
  }
  for (const id of expectedIds) {
    if (!byId.has(id)) {
      throw new Error(`SSH relay runtime release is missing required stage: ${id}`)
    }
  }
  return byId
}

function expectedSigningTuples(candidateTupleIds) {
  return candidateTupleIds.filter(
    (tupleId) => tupleId.startsWith('darwin-') || tupleId.startsWith('win32-')
  )
}

function assertUniqueAssetNames(assets) {
  const names = new Set()
  for (const asset of assets) {
    if (names.has(asset.name)) {
      throw new Error(`SSH relay runtime release has a duplicate asset name: ${asset.name}`)
    }
    names.add(asset.name)
  }
}

export function evaluateSshRelayRuntimeReleaseStages({
  candidateTupleIds,
  signingTupleIds,
  stages
}) {
  const candidates = normalizeTupleIds(candidateTupleIds, 'candidate tuples')
  const signing = normalizeTupleIds(signingTupleIds, 'signing tuples', { allowEmpty: true })
  const requiredSigning = expectedSigningTuples(candidates)
  if (!sameAssets(signing, requiredSigning)) {
    // Why: macOS and Windows candidates cannot bypass the returned native-signing boundary.
    throw new Error('SSH relay runtime release signing tuples do not match platform policy')
  }
  const expectedStageIds = [
    ...candidates.map((tupleId) => `build:${tupleId}`),
    ...signing.map((tupleId) => `sign:${tupleId}`),
    'aggregate',
    'upload',
    'readback'
  ]
  const stageResults = collectStages(stages, expectedStageIds)
  const builds = new Map()
  for (const tupleId of candidates) {
    builds.set(
      tupleId,
      normalizeRuntimeAsset(
        stageResults.get(`build:${tupleId}`).output,
        tupleId,
        `build:${tupleId} output`
      )
    )
  }
  const finalByTuple = new Map(builds)
  for (const tupleId of signing) {
    const output = stageResults.get(`sign:${tupleId}`).output
    assertExactFields(output, ['approval', 'inputSha256', 'asset'], `sign:${tupleId} output`)
    if (output.approval !== 'approved') {
      const reason =
        output.approval === 'denied'
          ? 'approval was denied'
          : output.approval === 'timed-out'
            ? 'approval timed out'
            : 'approval is absent'
      throw new Error(`SSH relay runtime release sign:${tupleId} ${reason}`)
    }
    if (output.inputSha256 !== builds.get(tupleId).sha256) {
      throw new Error(
        `SSH relay runtime release sign:${tupleId} unsigned input disagrees with build output`
      )
    }
    const signed = normalizeRuntimeAsset(output.asset, tupleId, `sign:${tupleId} returned asset`)
    if (
      signed.sha256 === output.inputSha256 ||
      signed.contentId === builds.get(tupleId).contentId
    ) {
      throw new Error(
        `SSH relay runtime release sign:${tupleId} did not produce a new immutable identity`
      )
    }
    finalByTuple.set(tupleId, signed)
  }
  const finalRuntimeAssets = candidates.map((tupleId) => finalByTuple.get(tupleId))
  assertUniqueAssetNames(finalRuntimeAssets)

  const aggregate = stageResults.get('aggregate').output
  assertExactFields(aggregate, ['inputAssets', 'manifest', 'signature'], 'aggregate output')
  assertAssetChain(aggregate.inputAssets, finalRuntimeAssets, 'aggregate input')
  const manifest = normalizeReleaseFile(
    aggregate.manifest,
    'orca-ssh-relay-runtime-manifest.json',
    'aggregate manifest',
    1024 * 1024
  )
  const signature = normalizeReleaseFile(
    aggregate.signature,
    'orca-ssh-relay-runtime-manifest.sig',
    'aggregate manifest signature',
    4096
  )
  const releaseAssets = [...finalRuntimeAssets, manifest, signature]
  assertUniqueAssetNames(releaseAssets)

  const upload = stageResults.get('upload').output
  assertExactFields(upload, ['inputAssets', 'uploadedAssets'], 'upload output')
  assertAssetChain(upload.inputAssets, releaseAssets, 'upload input')
  assertAssetChain(upload.uploadedAssets, releaseAssets, 'uploaded')
  const readback = stageResults.get('readback').output
  assertExactFields(readback, ['inputAssets', 'downloadedAssets'], 'readback output')
  assertAssetChain(readback.inputAssets, releaseAssets, 'readback input')
  assertAssetChain(readback.downloadedAssets, releaseAssets, 'readback downloaded')

  return { candidateTupleIds: candidates, finalRuntimeAssets, releaseAssets, publishable: true }
}
