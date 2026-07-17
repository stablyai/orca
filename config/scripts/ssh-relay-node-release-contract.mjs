import { createHash } from 'node:crypto'

const EXPECTED_TUPLES = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-glibc',
  'linux-x64-glibc',
  'win32-arm64',
  'win32-x64'
])

const ARCHIVE_SUFFIXES = Object.freeze({
  'darwin-arm64': 'darwin-arm64.tar.xz',
  'darwin-x64': 'darwin-x64.tar.xz',
  'linux-arm64-glibc': 'linux-arm64.tar.xz',
  'linux-x64-glibc': 'linux-x64.tar.xz',
  'win32-arm64': 'win-arm64.zip',
  'win32-x64': 'win-x64.zip'
})
const WINDOWS_LIBRARY_NAMES = Object.freeze({
  'win32-arm64': 'win-arm64/node.lib',
  'win32-x64': 'win-x64/node.lib'
})

const HEX_SHA256 = /^[0-9a-f]{64}$/
const OPENPGP_FINGERPRINT = /^[0-9A-F]{40}$/
const NODE_VERSION = /^\d+\.\d+\.\d+$/
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const MAX_SIGNATURE_BYTES = 1024 * 1024
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !HEX_SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertByteLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no larger than ${maximum}`)
  }
}

function expectedArchiveName(nodeVersion, tuple) {
  return `node-v${nodeVersion}-${ARCHIVE_SUFFIXES[tuple]}`
}

function validateMetadataContract(release) {
  assertRecord(release.checksumDocument, 'checksum document')
  assertExactKeys(release.checksumDocument, ['name', 'sha256', 'maximumBytes'], 'checksum document')
  if (release.checksumDocument.name !== 'SHASUMS256.txt') {
    throw new Error('checksum document name must be SHASUMS256.txt')
  }
  assertSha256(release.checksumDocument.sha256, 'checksum document SHA-256')
  assertByteLimit(
    release.checksumDocument.maximumBytes,
    MAX_METADATA_BYTES,
    'checksum document size limit'
  )

  assertRecord(release.signature, 'signature')
  assertExactKeys(
    release.signature,
    ['name', 'sha256', 'maximumBytes', 'signerFingerprint', 'key'],
    'signature'
  )
  if (release.signature.name !== 'SHASUMS256.txt.sig') {
    throw new Error('signature name must be SHASUMS256.txt.sig')
  }
  assertSha256(release.signature.sha256, 'signature SHA-256')
  assertByteLimit(release.signature.maximumBytes, MAX_SIGNATURE_BYTES, 'signature size limit')
  if (!OPENPGP_FINGERPRINT.test(release.signature.signerFingerprint)) {
    throw new Error('signature signer fingerprint must be 40 uppercase hexadecimal characters')
  }

  assertRecord(release.signature.key, 'signature key')
  assertExactKeys(
    release.signature.key,
    ['path', 'sha256', 'sourceCommit', 'sourceUrl'],
    'signature key'
  )
  if (typeof release.signature.key.path !== 'string' || release.signature.key.path.length === 0) {
    throw new Error('signature key path must be a non-empty string')
  }
  assertSha256(release.signature.key.sha256, 'signature key SHA-256')
  if (!/^[0-9a-f]{40}$/.test(release.signature.key.sourceCommit)) {
    throw new Error('signature key source commit must be a full lowercase SHA-1')
  }
  const expectedKeyUrl =
    `https://raw.githubusercontent.com/nodejs/release-keys/${release.signature.key.sourceCommit}` +
    `/keys/${release.signature.signerFingerprint}.asc`
  if (release.signature.key.sourceUrl !== expectedKeyUrl) {
    throw new Error('signature key source URL must use its exact immutable repository commit')
  }
}

function validateArchives(release) {
  assertByteLimit(release.maximumArchiveBytes, MAX_ARCHIVE_BYTES, 'archive size limit')
  assertRecord(release.archives, 'archives')
  const tuples = Object.keys(release.archives).sort()
  if (
    tuples.length !== EXPECTED_TUPLES.length ||
    tuples.some((tuple, index) => tuple !== EXPECTED_TUPLES[index])
  ) {
    throw new Error(`archive tuple set must be exactly: ${EXPECTED_TUPLES.join(', ')}`)
  }

  for (const tuple of EXPECTED_TUPLES) {
    const archive = release.archives[tuple]
    assertRecord(archive, `archive ${tuple}`)
    assertExactKeys(archive, ['name', 'sha256'], `archive ${tuple}`)
    if (archive.name !== expectedArchiveName(release.nodeVersion, tuple)) {
      throw new Error(`archive ${tuple} name does not match the pinned Node version and tuple`)
    }
    assertSha256(archive.sha256, `archive ${tuple} SHA-256`)
  }
}

function validateWindowsBuildInputs(release) {
  assertRecord(release.windowsBuildInputs, 'Windows build inputs')
  assertExactKeys(
    release.windowsBuildInputs,
    ['headersArchive', 'importLibraries'],
    'Windows build inputs'
  )
  const headers = release.windowsBuildInputs.headersArchive
  assertRecord(headers, 'Windows headers archive')
  assertExactKeys(headers, ['name', 'sha256'], 'Windows headers archive')
  if (headers.name !== `node-v${release.nodeVersion}-headers.tar.gz`) {
    throw new Error('Windows headers archive name does not match the pinned Node version')
  }
  assertSha256(headers.sha256, 'Windows headers archive SHA-256')

  const libraries = release.windowsBuildInputs.importLibraries
  assertRecord(libraries, 'Windows import libraries')
  assertExactKeys(libraries, Object.keys(WINDOWS_LIBRARY_NAMES), 'Windows import libraries')
  for (const [tuple, expectedName] of Object.entries(WINDOWS_LIBRARY_NAMES)) {
    const library = libraries[tuple]
    assertRecord(library, `Windows import library ${tuple}`)
    assertExactKeys(library, ['name', 'sha256'], `Windows import library ${tuple}`)
    if (library.name !== expectedName) {
      throw new Error(`Windows import library name does not match ${tuple}`)
    }
    assertSha256(library.sha256, `Windows import library ${tuple} SHA-256`)
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function validateSshRelayNodeReleaseContract(release) {
  assertRecord(release, 'Node release contract')
  assertExactKeys(
    release,
    [
      'schemaVersion',
      'nodeVersion',
      'baseUrl',
      'checksumDocument',
      'signature',
      'maximumArchiveBytes',
      'archives',
      'windowsBuildInputs'
    ],
    'Node release contract'
  )
  if (release.schemaVersion !== 1) {
    throw new Error('Node release contract schemaVersion must be 1')
  }
  if (typeof release.nodeVersion !== 'string' || !NODE_VERSION.test(release.nodeVersion)) {
    throw new Error('Node version must be an exact three-component release')
  }
  if (release.baseUrl !== `https://nodejs.org/dist/v${release.nodeVersion}`) {
    throw new Error('Node release base URL must be the immutable exact-version nodejs.org URL')
  }

  validateMetadataContract(release)
  validateArchives(release)
  validateWindowsBuildInputs(release)
  return release
}

function parseChecksumLines(bytes) {
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Node checksum document must be valid UTF-8')
  }
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  const entries = new Map()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([!-~]+)$/.exec(line)
    if (!match) {
      throw new Error('Node checksum document contains a malformed line')
    }
    const [, digest, name] = match
    if (entries.has(name)) {
      throw new Error(`Node checksum document contains duplicate entry: ${name}`)
    }
    entries.set(name, digest)
  }
  return entries
}

export function verifySshRelayNodeChecksumDocument(releaseInput, bytesInput) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  if (!Buffer.isBuffer(bytesInput) && !(bytesInput instanceof Uint8Array)) {
    throw new Error('Node checksum document must be bytes')
  }
  const bytes = Buffer.from(bytesInput)
  if (bytes.length === 0 || bytes.length > release.checksumDocument.maximumBytes) {
    throw new Error('Node checksum document exceeds its size limit')
  }

  // Parse first so duplicate or malformed names cannot be hidden behind a digest mismatch.
  const entries = parseChecksumLines(bytes)
  if (sha256(bytes) !== release.checksumDocument.sha256) {
    throw new Error('Node checksum document SHA-256 does not match the pinned contract')
  }

  const expectedFiles = [
    ...EXPECTED_TUPLES.map((tuple) => ({
      kind: 'runtime-archive',
      tuple,
      ...release.archives[tuple]
    })),
    { kind: 'windows-headers', ...release.windowsBuildInputs.headersArchive },
    ...Object.entries(release.windowsBuildInputs.importLibraries).map(([tuple, file]) => ({
      kind: 'windows-import-library',
      tuple,
      ...file
    }))
  ]
  return expectedFiles.map((file) => {
    const documentDigest = entries.get(file.name)
    if (documentDigest === undefined) {
      throw new Error(`Node checksum document is missing pinned input: ${file.name}`)
    }
    if (documentDigest !== file.sha256) {
      throw new Error(`Node checksum document digest mismatch for pinned input: ${file.name}`)
    }
    return file
  })
}

export { EXPECTED_TUPLES }
