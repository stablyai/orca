import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { verifyCliRuntimeDirectory } from '../bundled-cli-runtime.cjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function peSigningFields(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Runtime signing requires a complete PE image')
  }
  const pe = bytes.readUInt32LE(60)
  const optional = pe + 24
  if (optional + 2 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('Invalid runtime PE header')
  }
  const magic = bytes.readUInt16LE(optional)
  if (magic !== 0x20b && magic !== 0x10b) {
    throw new Error('Unsupported runtime PE optional header')
  }
  const directories = optional + (magic === 0x20b ? 112 : 96)
  const security = directories + 4 * 8
  if (
    security + 8 > bytes.length ||
    bytes.readUInt16LE(pe + 20) < security + 8 - optional ||
    bytes.readUInt32LE(directories - 4) < 5
  ) {
    throw new Error('Missing runtime PE certificate directory')
  }
  return {
    checksum: optional + 64,
    security,
    offset: bytes.readUInt32LE(security),
    size: bytes.readUInt32LE(security + 4)
  }
}

/** Signing may append a certificate and edit its directory/checksum, never executable bytes. */
export function assertAuthenticodeOnlyChange(original, signed) {
  const before = peSigningFields(original)
  const after = peSigningFields(signed)
  if (before.offset !== 0 || before.size !== 0) {
    throw new Error('Refusing to replace an existing vendor runtime signature')
  }
  const alignedLength = Math.ceil(original.length / 8) * 8
  if (
    after.checksum !== before.checksum ||
    after.security !== before.security ||
    after.offset !== alignedLength ||
    after.size < 8 ||
    after.offset + after.size !== signed.length
  ) {
    throw new Error('Signed runtime has unexpected certificate layout')
  }
  for (let offset = after.offset; offset < signed.length;) {
    if (offset + 8 > signed.length) {
      throw new Error('Truncated runtime certificate header')
    }
    const length = signed.readUInt32LE(offset)
    const paddedLength = Math.ceil(length / 8) * 8
    if (
      length < 8 ||
      offset + paddedLength > signed.length ||
      signed.readUInt16LE(offset + 4) !== 0x200 ||
      signed.readUInt16LE(offset + 6) !== 2
    ) {
      throw new Error('Malformed runtime certificate record')
    }
    offset += paddedLength
  }
  if (signed.subarray(original.length, alignedLength).some((byte) => byte !== 0)) {
    throw new Error('Signed runtime has nonzero alignment padding')
  }
  const image = Buffer.from(signed.subarray(0, original.length))
  original.copy(image, before.checksum, before.checksum, before.checksum + 4)
  original.copy(image, before.security, before.security, before.security + 8)
  if (!image.equals(original)) {
    throw new Error('Signing changed runtime executable bytes')
  }
}

export function finalizeSignedCliRuntime(appDirectory, signingStage) {
  const relative = join('resources', 'cli-runtime')
  const directory = join(appDirectory, relative)
  const manifestPath = join(directory, 'runtime.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!/^win32-(x64|arm64)$/.test(manifest.target) || manifest.version !== ORCAD_BUN_VERSION) {
    throw new Error('Invalid Windows runtime signing manifest')
  }
  const expected = ORCAD_BUN_RELEASE_ASSETS[manifest.target].executableSha256
  const signed = readFileSync(join(directory, 'bun-runtime.exe'))
  const signedHash = digest(signed)
  if (signedHash !== manifest.sha256) {
    const original = readFileSync(join(signingStage, relative, 'bun-runtime.exe'))
    if (digest(original) !== expected || manifest.sha256 !== expected) {
      throw new Error('Pre-sign runtime does not match the pinned release')
    }
    assertAuthenticodeOnlyChange(original, signed)
    const temporary = `${manifestPath}.signed-${process.pid}`
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ ...manifest, sha256: signedHash, unsignedSha256: expected })}\n`,
        { flag: 'wx' }
      )
      renameSync(temporary, manifestPath)
    } finally {
      rmSync(temporary, { force: true })
    }
  } else if (signedHash !== expected) {
    // Re-running is safe only while the retained original still proves the signed payload.
    const original = readFileSync(join(signingStage, relative, 'bun-runtime.exe'))
    if (digest(original) !== expected || manifest.unsignedSha256 !== expected) {
      throw new Error('Signed runtime provenance is missing')
    }
    assertAuthenticodeOnlyChange(original, signed)
  }
  verifyCliRuntimeDirectory(directory, 'win32', manifest.target.slice('win32-'.length))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('Usage: finalize-signed-cli-runtime.mjs <unpacked-app> <signing-stage>')
  }
  finalizeSignedCliRuntime(resolve(process.argv[2]), resolve(process.argv[3]))
}
