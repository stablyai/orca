import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeBundledCliRuntimeFixture } from './bundled-cli-runtime-fixture.mjs'
const pins = vi.hoisted(() => ({ hash: '' }))
vi.mock('../../src/shared/orcad-bun-runtime.ts', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    ORCAD_BUN_RELEASE_ASSETS: {
      'win32-x64': {
        get executableSha256() {
          return pins.hash
        }
      }
    }
  }
})
import {
  assertAuthenticodeOnlyChange,
  finalizeSignedCliRuntime
} from './finalize-signed-cli-runtime.mjs'
import { verifyCliRuntimeDirectory } from '../bundled-cli-runtime.cjs'
const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function images(magic = 0x20b) {
  const original = Buffer.alloc(515)
  original.write('MZ')
  original.writeUInt32LE(64, 60)
  original.write('PE\0\0', 64)
  original.writeUInt16LE(240, 84)
  original.writeUInt16LE(magic, 88)
  const directory = 88 + (magic === 0x20b ? 112 : 96)
  original.writeUInt32LE(16, directory - 4)
  original[510] = 42
  const signed = Buffer.concat([original, Buffer.alloc(5), Buffer.alloc(16, 7)])
  signed.writeUInt32LE(16, 520)
  signed.writeUInt16LE(0x200, 524)
  signed.writeUInt16LE(2, 526)
  signed.writeUInt32LE(123, 88 + 64)
  signed.writeUInt32LE(520, directory + 32)
  signed.writeUInt32LE(16, directory + 36)
  return { original, signed, security: directory + 32 }
}

it.each([0x20b, 0x10b])(
  'allows only certificate append/checksum edits for PE magic %s',
  (magic) => {
    const { original, signed } = images(magic)
    expect(() => assertAuthenticodeOnlyChange(original, signed)).not.toThrow()
  }
)
it.each([
  'code',
  'padding',
  'tail',
  'directory',
  'vendor-signature',
  'certificate-length',
  'certificate-type'
])('rejects unexpected signing change: %s', (kind) => {
  let { original, signed, security } = images()
  if (kind === 'certificate-length') {
    signed.writeUInt32LE(1000, 520)
  }
  if (kind === 'certificate-type') {
    signed.writeUInt16LE(1, 526)
  }
  if (kind === 'code') {
    signed[510]++
  }
  if (kind === 'padding') {
    signed[517] = 1
  }
  if (kind === 'tail') {
    signed = Buffer.concat([signed, Buffer.from('extra')])
  }
  if (kind === 'directory') {
    signed.writeUInt32LE(512, security)
  }
  if (kind === 'vendor-signature') {
    original.writeUInt32LE(512, security)
  }
  expect(() => assertAuthenticodeOnlyChange(original, signed)).toThrow()
})
it('rejects truncated or non-PE images', () => {
  expect(() => assertAuthenticodeOnlyChange(Buffer.from('bad'), Buffer.from('bad'))).toThrow()
})

async function stagedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'signed-runtime-'))
  roots.push(root)
  const app = join(root, 'app')
  const stage = join(root, 'signing-stage')
  const relative = join('resources', 'cli-runtime')
  const directory = join(app, relative)
  await writeBundledCliRuntimeFixture(directory, 'win32', 'x64')
  const { original, signed } = images()
  pins.hash = hash(original)
  mkdirSync(join(stage, relative), { recursive: true })
  writeFileSync(join(stage, relative, 'bun-runtime.exe'), original)
  writeFileSync(join(directory, 'bun-runtime.exe'), signed)
  const manifestPath = join(directory, 'runtime.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: pins.hash }))
  return { app, stage, directory, manifestPath, signed }
}
it('finalizes the signed full-file identity, preserving runtime verification and repeatability', async () => {
  const f = await stagedFixture()
  expect(() => verifyCliRuntimeDirectory(f.directory, 'win32', 'x64')).toThrow('checksum')
  finalizeSignedCliRuntime(f.app, f.stage)
  expect(JSON.parse(readFileSync(f.manifestPath, 'utf8'))).toMatchObject({
    sha256: hash(f.signed),
    unsignedSha256: pins.hash
  })
  expect(() => verifyCliRuntimeDirectory(f.directory, 'win32', 'x64')).not.toThrow()
  expect(() => finalizeSignedCliRuntime(f.app, f.stage)).not.toThrow()
  f.signed[510]++
  writeFileSync(join(f.directory, 'bun-runtime.exe'), f.signed)
  expect(() => verifyCliRuntimeDirectory(f.directory, 'win32', 'x64')).toThrow('checksum')
})
it('refuses to bless payload changes or unpinned original bytes', async () => {
  const f = await stagedFixture()
  f.signed[510]++
  writeFileSync(join(f.directory, 'bun-runtime.exe'), f.signed)
  expect(() => finalizeSignedCliRuntime(f.app, f.stage)).toThrow('executable bytes')
  pins.hash = '0'.repeat(64)
  expect(() => finalizeSignedCliRuntime(f.app, f.stage)).toThrow('pinned release')
})

it('refuses a changed original manifest without rewriting it', async () => {
  const f = await stagedFixture()
  const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'))
  const changed = JSON.stringify({ ...manifest, sha256: 'f'.repeat(64) })
  writeFileSync(f.manifestPath, changed)
  expect(() => finalizeSignedCliRuntime(f.app, f.stage)).toThrow('pinned release')
  expect(readFileSync(f.manifestPath, 'utf8')).toBe(changed)
})
