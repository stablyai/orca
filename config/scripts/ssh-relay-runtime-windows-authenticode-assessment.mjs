import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'

const AUTHENTICODE_JSON_FIELDS = ['signerSubject', 'signerThumbprint', 'status']
const POWERSHELL_TIMEOUT_MS = 30_000
const POWERSHELL_MAX_BUFFER_BYTES = 64 * 1024

const POWERSHELL_AUTHENTICODE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:ORCA_SSH_RELAY_AUTHENTICODE_FILE
$certificate = $signature.SignerCertificate
[pscustomobject]@{
  status = $signature.Status.ToString()
  signerSubject = if ($null -eq $certificate) { $null } else { $certificate.Subject }
  signerThumbprint = if ($null -eq $certificate) { $null } else { $certificate.Thumbprint }
} | ConvertTo-Json -Compress
`

function localPath(root, portablePath) {
  if (
    typeof portablePath !== 'string' ||
    portablePath.length === 0 ||
    portablePath.includes('\\') ||
    portablePath.startsWith('/') ||
    portablePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Runtime Authenticode assessment rejects non-portable path: ${portablePath}`)
  }
  return resolve(root, ...portablePath.split('/'))
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return `sha256:${hash.digest('hex')}`
}

function containsAsciiControl(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime Authenticode ${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`Runtime Authenticode ${label} has unexpected fields`)
  }
}

export function parseSshRelayRuntimeWindowsAuthenticodeJson(stdout) {
  const source = typeof stdout === 'string' ? stdout.trim() : ''
  if (!source) {
    throw new Error('PowerShell did not return runtime Authenticode JSON')
  }
  let result
  try {
    result = JSON.parse(source)
  } catch (error) {
    throw new Error(`PowerShell returned malformed runtime Authenticode JSON: ${error.message}`)
  }
  assertExactFields(result, AUTHENTICODE_JSON_FIELDS, 'result')
  if (
    typeof result.status !== 'string' ||
    ![null, 'string'].includes(
      result.signerSubject === null ? null : typeof result.signerSubject
    ) ||
    ![null, 'string'].includes(
      result.signerThumbprint === null ? null : typeof result.signerThumbprint
    )
  ) {
    throw new Error('Runtime Authenticode result has malformed field types')
  }
  return result
}

export function classifySshRelayRuntimeWindowsAuthenticode(signature) {
  if (signature.status === 'NotSigned') {
    if (signature.signerSubject !== null || signature.signerThumbprint !== null) {
      throw new Error('Runtime Authenticode unsigned result unexpectedly contains a certificate')
    }
    return { status: 'unsigned' }
  }
  if (signature.status !== 'Valid') {
    throw new Error(`Runtime Authenticode rejects signature status: ${signature.status}`)
  }
  if (
    typeof signature.signerSubject !== 'string' ||
    signature.signerSubject.length === 0 ||
    signature.signerSubject.length > 1024 ||
    containsAsciiControl(signature.signerSubject) ||
    typeof signature.signerThumbprint !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(signature.signerThumbprint)
  ) {
    throw new Error('Runtime Authenticode valid result has malformed certificate identity')
  }
  return {
    status: 'valid-upstream',
    signerSubject: signature.signerSubject,
    signerThumbprint: signature.signerThumbprint.toUpperCase()
  }
}

export function getSshRelayRuntimeWindowsAuthenticodeJson(path, spawnSyncImpl = spawnSync) {
  // Why: the candidate path stays out of PowerShell source so spaces and metacharacters are data only.
  const result = spawnSyncImpl(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_AUTHENTICODE_SCRIPT],
    {
      encoding: 'utf8',
      env: { ...process.env, ORCA_SSH_RELAY_AUTHENTICODE_FILE: path },
      maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true
    }
  )
  if (result?.error) {
    throw result.error
  }
  if (result?.stderr?.trim()) {
    throw new Error(
      `PowerShell wrote to stderr during runtime Authenticode assessment: ${result.stderr.trim()}`
    )
  }
  if (result?.status !== 0) {
    throw new Error(
      `PowerShell runtime Authenticode assessment failed with exit code ${result?.status ?? '<unknown>'}`
    )
  }
  if (typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    throw new Error('PowerShell did not return runtime Authenticode JSON')
  }
  return result.stdout
}

async function authenticatedCandidate(physicalRuntimeRoot, identityEntry, planEntry) {
  const path = localPath(physicalRuntimeRoot, planEntry.path)
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Runtime Authenticode candidate is a symbolic link: ${planEntry.path}`)
  }
  if (!metadata.isFile()) {
    throw new Error(`Runtime Authenticode candidate is not a regular file: ${planEntry.path}`)
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`Runtime Authenticode candidate traverses a symbolic link: ${planEntry.path}`)
  }
  if (metadata.size !== identityEntry.size) {
    throw new Error(
      `Runtime Authenticode candidate has wrong authenticated size: ${planEntry.path}`
    )
  }
  if ((await sha256File(path)) !== planEntry.sourceSha256) {
    throw new Error(
      `Runtime Authenticode candidate has wrong authenticated hash: ${planEntry.path}`
    )
  }
  return { path, planEntry }
}

async function assertCandidateUnchanged(candidate) {
  if ((await sha256File(candidate.path)) !== candidate.planEntry.sourceSha256) {
    throw new Error(
      `Runtime Authenticode candidate changed during assessment: ${candidate.planEntry.path}`
    )
  }
}

export async function assessSshRelayRuntimeWindowsAuthenticode({
  identity,
  runtimeRoot,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'win32') {
    throw new Error('Runtime Authenticode assessment requires Windows')
  }
  const plan = buildSshRelayRuntimeNativeSigningPlan(identity)
  if (plan.platform !== 'win32') {
    throw new Error(
      `Runtime Authenticode assessment rejects non-Windows tuple: ${identity.tupleId}`
    )
  }
  const runtimeMetadata = await lstat(runtimeRoot)
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) {
    throw new Error('Runtime Authenticode source root must be a real directory')
  }
  const physicalRuntimeRoot = await realpath(runtimeRoot)
  const identityEntries = new Map(identity.entries.map((entry) => [entry.path, entry]))
  const candidates = await Promise.all(
    plan.signingCandidates.map((entry) =>
      authenticatedCandidate(physicalRuntimeRoot, identityEntries.get(entry.path), entry)
    )
  )

  const assessments = []
  for (const candidate of candidates) {
    const signature = parseSshRelayRuntimeWindowsAuthenticodeJson(
      getSshRelayRuntimeWindowsAuthenticodeJson(candidate.path, spawnSyncImpl)
    )
    const classification = classifySshRelayRuntimeWindowsAuthenticode(signature)
    await assertCandidateUnchanged(candidate)
    assessments.push({
      path: candidate.planEntry.path,
      sourceSha256: candidate.planEntry.sourceSha256,
      ...classification
    })
  }
  return assessments
}
