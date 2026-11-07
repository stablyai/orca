import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES } from './iroh-prebuild.mjs'
import {
  COMPAT_SLOT_ADDONS,
  findSlotProblems,
  mergeManifest,
  sha256Of
} from './orcad-prebuild-slot-contents.mjs'
const dirs = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-slot-contents-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const entry = (files = {}) => ({
  platform: 'darwin',
  arch: 'arm64',
  libc: 'none',
  glibc: null,
  napi: 8,
  files
})
const next = (slot, overrides = {}) => ({
  slot,
  version: '1.1.0',
  napi: 8,
  nodeHeaders: '24.21.0',
  entry: entry(),
  ...overrides
})

/** Creates a GNU slot with a hashed ELF64 header and a detached SDK build identity. */
function gnuEntry(dir, slot) {
  const relative = IROH_PREBUILD_FILES[slot]
  const native = join(dir, slot, relative)
  mkdirSync(dirname(native), { recursive: true })
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(slot === 'linux-x64-glibc' ? 62 : 183, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeUInt16LE(64, 52)
  writeFileSync(native, bytes)
  const pty = join(dir, slot, 'pty.node')
  writeFileSync(pty, 'pty fixture')
  return {
    ...entry({ 'pty.node': sha256Of(pty), [relative]: sha256Of(native) }),
    platform: 'linux',
    arch: slot === 'linux-x64-glibc' ? 'x64' : 'arm64',
    libc: 'glibc',
    glibc: '2.28',
    iroh: structuredClone(IROH_BUILD_IDENTITY)
  }
}

describe('findSlotProblems', () => {
  it('passes only when every named slot is present and every file matches its hash', () => {
    const dir = temp()
    mkdirSync(join(dir, 'darwin-arm64'))
    writeFileSync(join(dir, 'darwin-arm64', 'pty.node'), 'binary')
    const manifest = mergeManifest(
      null,
      next('darwin-arm64', {
        entry: entry({ 'pty.node': sha256Of(join(dir, 'darwin-arm64', 'pty.node')) })
      })
    )
    expect(findSlotProblems(manifest, dir, ['darwin-arm64'])).toEqual([])
    expect(findSlotProblems(manifest, dir, ['darwin-arm64', 'win32-x64'])).toEqual([
      'win32-x64: not built'
    ])
    writeFileSync(join(dir, 'darwin-arm64', 'pty.node'), 'torn')
    expect(findSlotProblems(manifest, dir, ['darwin-arm64'])).toEqual([
      'darwin-arm64/pty.node: sha256 does not match the manifest'
    ])
    expect(findSlotProblems(null, dir, ['darwin-arm64'])).toEqual([
      'manifest.json is missing or not schema 2'
    ])
  })

  it.each(['linux-x64-glibc', 'linux-arm64-glibc'])(
    'requires current SDK identity for %s independently of the node-pty version',
    (slot) => {
      const dir = temp()
      const slotEntry = gnuEntry(dir, slot)
      const manifest = mergeManifest(null, next(slot, { version: '2.0.0', entry: slotEntry }))
      expect(manifest.version).not.toBe(IROH_BUILD_IDENTITY.sdkVersion)
      expect(findSlotProblems(manifest, dir, [slot])).toEqual([])
      delete slotEntry.iroh
      expect(findSlotProblems(manifest, dir, [slot])).toEqual([
        expect.stringMatching(/iroh.*identity/i)
      ])
      slotEntry.iroh = { ...IROH_BUILD_IDENTITY, recipe: 'old-recipe' }
      expect(findSlotProblems(manifest, dir, [slot])).toEqual([
        expect.stringMatching(/iroh.*identity/i)
      ])
    }
  )

  it.each(['linux-x64-glibc', 'linux-arm64-glibc'])(
    'rejects %s without a native SDK even when it is absent from the file list',
    (slot) => {
      const dir = temp()
      const slotEntry = gnuEntry(dir, slot)
      const relative = IROH_PREBUILD_FILES[slot]
      rmSync(join(dir, slot, relative))
      delete slotEntry.files[relative]
      const manifest = mergeManifest(null, next(slot, { entry: slotEntry }))
      expect(findSlotProblems(manifest, dir, [slot])).toEqual([
        expect.stringMatching(/missing iroh native file/i)
      ])
    }
  )

  it('keeps compat addons required without requiring a GNU SDK artifact', () => {
    const dir = temp()
    const slot = 'linux-x64-glibc217'
    const files = {}
    for (const relative of ['pty.node', ...Object.keys(COMPAT_SLOT_ADDONS)]) {
      const file = join(dir, slot, relative)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'compat fixture')
      files[relative] = sha256Of(file)
    }
    const manifest = mergeManifest(
      null,
      next(slot, {
        entry: { ...entry(files), platform: 'linux', arch: 'x64', libc: 'glibc', glibc: '2.17' }
      })
    )
    expect(findSlotProblems(manifest, dir, [slot])).toEqual([])
    const [addon] = Object.keys(COMPAT_SLOT_ADDONS)
    delete manifest.slots[slot].files[addon]
    expect(findSlotProblems(manifest, dir, [slot])).toEqual([`${slot}/${addon}: not built`])
  })
})
