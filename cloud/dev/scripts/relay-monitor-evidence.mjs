import { createHash } from 'node:crypto'
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/
const SHA = /^[a-f0-9]{40}$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const EVIDENCE_MAX_AGE_MS = 5 * 60_000
// Matches the same-cap cell job timeout-minutes; bounds each predecessor wave.
const WAVE_PREDECESSOR_TIMEOUT_MS = 75 * 60_000
const WAVE_INDEX = /^[0-3]$/
const EVIDENCE_SAMPLE_INTERVAL_MS = 60_000
const EVIDENCE_MAX_LINEAGE_MS = 25 * 60_000
const MIGRATION_POLICIES = new Set([
  'strict',
  'recover-forward',
  'capacity-transition'
])
const MUTATION_MODES = new Set([
  'capacity-transition',
  'continue-evacuation',
  'disable-cell',
  'enable-empty-cell',
  'execute',
  'fence-source',
  'recover-forward',
  'reset-empty-candidate'
])

function argumentsByName(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('relay monitor evidence arguments are invalid')
    }
    values[name.slice(2)] = value
  }
  return values
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function provenance(values) {
  const runAttempt = Number(values['run-attempt'])
  if (
    !SAFE_ID.test(values['incident-id'] ?? '') ||
    !SAFE_ID.test(values['run-id'] ?? '') ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !SHA.test(values['commit-sha'] ?? '') ||
    !['dry-run', 'monitor'].includes(values.mode)
  ) {
    throw new Error('relay monitor evidence provenance is invalid')
  }
  return {
    incidentId: values['incident-id'],
    runId: values['run-id'],
    runAttempt,
    commitSha: values['commit-sha'],
    mode: values.mode
  }
}

export async function createEvidenceManifest(argv) {
  const values = argumentsByName(argv)
  const directory = resolve(values.directory ?? '')
  const expected = provenance(values)
  const candidates = [
    `${expected.incidentId}.state.json`,
    `${expected.incidentId}.summaries.jsonl`,
    `${expected.incidentId}.summary.md`
  ]
  const files = {}
  for (const name of candidates) {
    const path = join(directory, name)
    if (await regularFile(path)) files[name] = await sha256(path)
  }
  if (!files[`${expected.incidentId}.state.json`]) {
    throw new Error('relay monitor durable state is missing')
  }
  const manifest = {
    schemaVersion: 1,
    ...expected,
    files
  }
  const path = join(directory, 'evidence-manifest.json')
  await writeFile(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return manifest
}

async function readAndVerifyManifest(directory, expected) {
  const manifest = JSON.parse(
    await readFile(join(directory, 'evidence-manifest.json'), 'utf8')
  )
  if (
    manifest.schemaVersion !== 1 ||
    manifest.incidentId !== expected.incidentId ||
    manifest.runId !== expected.runId ||
    manifest.runAttempt !== expected.runAttempt ||
    manifest.commitSha !== expected.commitSha ||
    manifest.mode !== expected.mode
  ) {
    throw new Error('relay monitor evidence provenance does not match')
  }
  const names = Object.keys(manifest.files ?? {})
  if (!names.includes(`${expected.incidentId}.state.json`)) {
    throw new Error('relay monitor evidence has no durable state')
  }
  for (const name of names) {
    if (basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('relay monitor evidence file name is invalid')
    }
    if (await sha256(join(directory, name)) !== manifest.files[name]) {
      throw new Error('relay monitor evidence hash does not match')
    }
  }
  const allowed = new Set([...names, 'evidence-manifest.json'])
  const unexpected = (await readdir(directory)).filter((name) => !allowed.has(name))
  if (unexpected.length > 0) throw new Error('relay monitor evidence has unexpected files')
  return manifest
}

function validMigrationPolicyState(state) {
  return (
    (
      state.migrationPolicy === 'strict' &&
      state.recoverySourceCellId === null &&
      state.capacityCellId === null
    ) ||
    (
      state.migrationPolicy === 'recover-forward' &&
      state.capacityCellId === null &&
      typeof state.recoverySourceCellId === 'string' &&
      state.expectedSelector?.membership?.existingOnly?.includes(
        state.recoverySourceCellId
      )
    ) ||
    (
      state.migrationPolicy === 'capacity-transition' &&
      state.recoverySourceCellId === null &&
      typeof state.capacityCellId === 'string' &&
      state.expectedSelector?.membership?.general?.includes(state.capacityCellId)
    )
  )
}

export async function verifyRestoredEvidence(argv) {
  const values = argumentsByName(argv)
  const directory = resolve(values.directory ?? '')
  const expected = provenance(values)
  await readAndVerifyManifest(directory, expected)
  const state = JSON.parse(
    await readFile(join(directory, `${expected.incidentId}.state.json`), 'utf8')
  )
  if (
    state.schemaVersion !== 4 ||
    state.incidentId !== expected.incidentId ||
    state.environment !== 'production' ||
    state.preDrainDryRun !== (expected.mode === 'dry-run') ||
    !MIGRATION_POLICIES.has(state.migrationPolicy) ||
    !validMigrationPolicyState(state)
  ) {
    throw new Error('relay monitor restored state does not match provenance')
  }
  return state
}

function validCompletedDryRunState(state, expected, nowMs, maxAgeMs) {
  const completedAt = Date.parse(state.completedAt)
  const startedAt = Date.parse(state.startedAt)
  const windowStartedAt = Date.parse(state.windowStartedAt)
  const lastSampleAt = Date.parse(state.lastSampleAt)
  const age = nowMs - completedAt
  return (
    state.schemaVersion === 4 &&
    state.incidentId === expected.incidentId &&
    state.environment === 'production' &&
    state.preDrainDryRun === true &&
    validMigrationPolicyState(state) &&
    state.durationMinutes === 15 &&
    state.intervalMs === EVIDENCE_SAMPLE_INTERVAL_MS &&
    state.sampleCount >= 16 &&
    state.frozenAt === null &&
    Number.isFinite(startedAt) &&
    completedAt - startedAt >= 0 &&
    completedAt - startedAt <= EVIDENCE_MAX_LINEAGE_MS &&
    Number.isFinite(windowStartedAt) &&
    completedAt - windowStartedAt >= 15 * 60_000 &&
    Number.isFinite(lastSampleAt) &&
    lastSampleAt <= completedAt &&
    completedAt - lastSampleAt <= state.intervalMs &&
    Number.isFinite(completedAt) &&
    age >= 0 &&
    age <= maxAgeMs
  )
}

export async function verifyDryRunAuthority(argv, now = Date.now) {
  const values = argumentsByName(argv)
  const directory = resolve(values.directory ?? '')
  const expected = provenance(values)
  if (expected.mode !== 'dry-run') throw new Error('relay mutation requires dry-run evidence')
  const manifest = await readAndVerifyManifest(directory, expected)
  const state = JSON.parse(
    await readFile(join(directory, `${expected.incidentId}.state.json`), 'utf8')
  )
  const requiredMigrationPolicy = values['required-migration-policy']
  // Later same-cap waves start after sequential predecessor cell rolls, so the
  // freshness bound grows by one cell-job timeout per predecessor; single-use
  // consumption, needs-chaining, and each wave's live preflight recheck keep
  // holding the mutation to current health.
  const waveIndex = values['wave-index'] ?? '0'
  if (!WAVE_INDEX.test(waveIndex)) {
    throw new Error('relay monitor wave index is invalid')
  }
  const maxAgeMs =
    EVIDENCE_MAX_AGE_MS + Number(waveIndex) * WAVE_PREDECESSOR_TIMEOUT_MS
  if (
    !MIGRATION_POLICIES.has(requiredMigrationPolicy) ||
    state.migrationPolicy !== requiredMigrationPolicy ||
    !validCompletedDryRunState(state, expected, now(), maxAgeMs)
  ) {
    throw new Error('relay monitor dry-run authority is incomplete or stale')
  }
  return { manifest, state }
}

function exactSelector(actual, expected) {
  const membership = (selector) => {
    if (
      !selector?.membership ||
      !['existingOnly', 'migrationOnly', 'general'].every((key) =>
        Array.isArray(selector.membership[key])
      )
    ) return null
    const normalized = Object.fromEntries(
      ['existingOnly', 'migrationOnly', 'general'].map((key) => [
        key,
        [...selector.membership[key]].sort()
      ])
    )
    const all = Object.values(normalized).flat()
    return new Set(all).size === all.length ? normalized : null
  }
  const actualMembership = membership(actual)
  const expectedMembership = membership(expected)
  return Boolean(
    actualMembership &&
    expectedMembership &&
    actual?.generation === expected?.generation &&
    JSON.stringify(actualMembership) === JSON.stringify(expectedMembership)
  )
}

export async function verifyMutationEvidence(
  argv,
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now
) {
  const values = argumentsByName(argv)
  const directory = resolve(values.directory ?? '')
  const expected = provenance(values)
  if (expected.mode !== 'dry-run') throw new Error('mutation requires dry-run evidence')
  const manifest = await readAndVerifyManifest(directory, expected)
  const state = JSON.parse(
    await readFile(join(directory, `${expected.incidentId}.state.json`), 'utf8')
  )
  const mutationMode = values['mutation-mode']
  if (!MUTATION_MODES.has(mutationMode)) {
    throw new Error('relay monitor mutation mode is invalid')
  }
  const scopedRecoverySourceCellId =
    values['scoped-recovery-source-cell-id']
  const recoveryMutation = ['fence-source', 'recover-forward'].includes(mutationMode)
  const scopedRecoveryMutation =
    ['execute', 'recover-forward'].includes(mutationMode) &&
    Boolean(scopedRecoverySourceCellId)
  if (scopedRecoverySourceCellId && !scopedRecoveryMutation) {
    throw new Error('relay monitor scoped recovery evidence is invalid')
  }
  const requiredMigrationPolicy = mutationMode === 'capacity-transition'
    ? 'capacity-transition'
    : recoveryMutation || scopedRecoveryMutation ? 'recover-forward' : 'strict'
  if (state.migrationPolicy !== requiredMigrationPolicy) {
    throw new Error('relay monitor migration policy does not match mutation')
  }
  const expectedRecoverySourceCellId = scopedRecoveryMutation
    ? scopedRecoverySourceCellId
    : values['source-cell-id']
  if (
    (recoveryMutation || scopedRecoveryMutation) &&
    state.recoverySourceCellId !== expectedRecoverySourceCellId
  ) {
    throw new Error('relay monitor recovery source does not match mutation')
  }
  if (
    mutationMode === 'capacity-transition' &&
    state.capacityCellId !== values['source-cell-id']
  ) {
    throw new Error('relay monitor capacity cell does not match mutation')
  }
  if (
    !validCompletedDryRunState(state, expected, now(), EVIDENCE_MAX_AGE_MS)
  ) {
    throw new Error('relay monitor dry-run evidence is incomplete or stale')
  }
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  const origin = values['director-origin']
  if (!token || !JWT.test(token) || !origin?.startsWith('https://')) {
    throw new Error('relay monitor live selector verification is unavailable')
  }
  const response = await fetchImpl(`${origin}/v1/admin/admission-selector/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1 }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error('relay monitor live selector verification failed')
  const current = (await response.json()).selector
  if (!exactSelector(current, state.expectedSelector)) {
    throw new Error('relay admission selector changed after the dry run')
  }
  return { manifest, state }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (command === 'create') await createEvidenceManifest(argv)
  else if (command === 'verify-restore') await verifyRestoredEvidence(argv)
  else if (command === 'verify-authority') await verifyDryRunAuthority(argv)
  else if (command === 'verify-mutation') await verifyMutationEvidence(argv)
  else throw new Error('relay monitor evidence command is invalid')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'relay monitor evidence failed')
    process.exitCode = 1
  })
}
