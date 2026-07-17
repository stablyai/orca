import { isDeepStrictEqual } from 'node:util'

import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const WINDOWS_UNSIGNED_FIELDS = ['path', 'sourceSha256', 'status']
const WINDOWS_VALID_FIELDS = ['path', 'signerSubject', 'signerThumbprint', 'sourceSha256', 'status']

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime native signing ${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`Runtime native signing ${label} has unexpected fields`)
  }
}

function authenticatedFile(identityEntries, planEntry) {
  const entry = identityEntries.get(planEntry.path)
  if (!entry || entry.type !== 'file') {
    throw new Error(`Runtime native signing identity is missing file: ${planEntry.path}`)
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error(`Runtime native signing identity has invalid size: ${planEntry.path}`)
  }
  if (!SHA256_PATTERN.test(entry.sha256)) {
    throw new Error(`Runtime native signing identity has invalid digest: ${planEntry.path}`)
  }
  if (entry.sha256 !== planEntry.sourceSha256 || entry.role !== planEntry.role) {
    throw new Error(`Runtime native signing identity disagrees with plan: ${planEntry.path}`)
  }
  return {
    path: entry.path,
    role: entry.role,
    sourceSha256: entry.sha256,
    sourceSize: entry.size
  }
}

function indexIdentityFiles(identity) {
  const entries = new Map()
  for (const entry of identity.entries) {
    if (entry.type === 'file') {
      entries.set(entry.path, entry)
    }
  }
  return entries
}

function containsAsciiControl(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function assertSignerIdentity(assessment) {
  if (
    typeof assessment.signerSubject !== 'string' ||
    assessment.signerSubject.length === 0 ||
    assessment.signerSubject.length > 1024 ||
    containsAsciiControl(assessment.signerSubject)
  ) {
    throw new Error(
      `Runtime native signing assessment has invalid signer subject: ${assessment.path}`
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(assessment.signerThumbprint)) {
    throw new Error(
      `Runtime native signing assessment has invalid signer thumbprint: ${assessment.path}`
    )
  }
}

function windowsSelection(plan, identityEntries, assessments) {
  if (!Array.isArray(assessments)) {
    throw new Error('Runtime native signing Windows assessments must be an array')
  }
  const candidates = new Map(plan.signingCandidates.map((entry) => [entry.path, entry]))
  const indexed = new Map()
  for (const assessment of assessments) {
    if (!assessment || typeof assessment.path !== 'string' || !candidates.has(assessment.path)) {
      throw new Error(`Runtime native signing has unexpected assessment: ${assessment?.path}`)
    }
    if (indexed.has(assessment.path)) {
      throw new Error(`Runtime native signing has duplicate assessment: ${assessment.path}`)
    }
    if (!['unsigned', 'valid-upstream'].includes(assessment.status)) {
      throw new Error(`Runtime native signing rejects signature status: ${assessment.status}`)
    }
    assertExactFields(
      assessment,
      assessment.status === 'unsigned' ? WINDOWS_UNSIGNED_FIELDS : WINDOWS_VALID_FIELDS,
      'assessment'
    )
    const candidate = candidates.get(assessment.path)
    if (assessment.sourceSha256 !== candidate.sourceSha256) {
      throw new Error(`Runtime native signing assessment has wrong source hash: ${assessment.path}`)
    }
    if (assessment.status === 'valid-upstream') {
      assertSignerIdentity(assessment)
    }
    indexed.set(assessment.path, assessment)
  }

  return plan.signingCandidates.map((candidate) => {
    const assessment = indexed.get(candidate.path)
    if (!assessment) {
      throw new Error(`Runtime native signing is missing assessment: ${candidate.path}`)
    }
    const file = authenticatedFile(identityEntries, candidate)
    return assessment.status === 'unsigned'
      ? { ...file, action: 'signpath-required' }
      : {
          ...file,
          action: 'preserve-valid-upstream',
          signerSubject: assessment.signerSubject,
          signerThumbprint: assessment.signerThumbprint.toUpperCase()
        }
  })
}

export function buildSshRelayRuntimeNativeSigningSelection(identity, assessments) {
  const plan = buildSshRelayRuntimeNativeSigningPlan(identity)
  const identityEntries = indexIdentityFiles(identity)
  const immutableVendorFiles = plan.immutableVendorFiles.map((entry) => ({
    ...authenticatedFile(identityEntries, entry),
    action: entry.action
  }))
  const verificationFiles = plan.verificationFiles.map((entry) =>
    authenticatedFile(identityEntries, entry)
  )

  let candidateFiles
  if (plan.platform === 'win32') {
    candidateFiles = windowsSelection(plan, identityEntries, assessments)
  } else {
    if (!Array.isArray(assessments) || assessments.length !== 0) {
      throw new Error(`Runtime native signing ${plan.platform} does not accept assessments`)
    }
    candidateFiles = plan.signingCandidates.map((entry) => ({
      ...authenticatedFile(identityEntries, entry),
      action: entry.action
    }))
  }

  return {
    tupleId: plan.tupleId,
    platform: plan.platform,
    policy: plan.policy,
    immutableVendorFiles,
    signingFiles: candidateFiles.filter((entry) => entry.action !== 'preserve-valid-upstream'),
    preservedUpstreamFiles: candidateFiles.filter(
      (entry) => entry.action === 'preserve-valid-upstream'
    ),
    verificationFiles
  }
}

export function assertSshRelayRuntimeNativeSigningSelection(identity, selection) {
  if (
    !selection ||
    typeof selection !== 'object' ||
    !Array.isArray(selection.signingFiles) ||
    !Array.isArray(selection.preservedUpstreamFiles)
  ) {
    throw new Error('Runtime native signing requires a complete selection')
  }
  const assessments =
    identity.os === 'win32'
      ? [
          ...selection.signingFiles.map((entry) => ({
            path: entry.path,
            sourceSha256: entry.sourceSha256,
            status: 'unsigned'
          })),
          ...selection.preservedUpstreamFiles.map((entry) => ({
            path: entry.path,
            sourceSha256: entry.sourceSha256,
            status: 'valid-upstream',
            signerSubject: entry.signerSubject,
            signerThumbprint: entry.signerThumbprint
          }))
        ]
      : []
  const expected = buildSshRelayRuntimeNativeSigningSelection(identity, assessments)
  if (!isDeepStrictEqual(selection, expected)) {
    // Why: signing selections cross a job boundary and must remain bound to authenticated bytes.
    throw new Error('Runtime native signing selection and identity disagree')
  }
}
