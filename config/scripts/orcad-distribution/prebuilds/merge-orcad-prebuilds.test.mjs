import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeOrcadPrebuildTrees } from './merge-orcad-prebuilds.mjs'
import { IROH_BUILD_IDENTITY, IROH_PREBUILD_FILES } from './iroh-prebuild.mjs'
import {
  COMPAT_SLOT_ADDONS,
  isCompatSlot,
  mergeManifest,
  readManifest,
  sha256Of
} from './orcad-prebuild-slot-contents.mjs'

const dirs = []
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-merge-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Minimal ELF64 little-endian header plus lane-specific bytes, not a loadable SDK. */
function nativeBytes(slot, payload) {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(slot === 'linux-x64-glibc' ? 62 : 183, 18)
  header.writeUInt32LE(1, 20)
  header.writeUInt16LE(64, 52)
  return Buffer.concat([header, Buffer.from(payload)])
}

/** One CI lane's tree, including the hashed floor-built SDK only for normal GNU slots. */
function laneTree(slot, { version = '2.0.0', nodeHeaders = '24.21.0', bytes = slot } = {}) {
  const dir = temp()
  const files = {}
  // A compat slot also carries its own addons.
  for (const file of ['pty.node', ...(isCompatSlot(slot) ? Object.keys(COMPAT_SLOT_ADDONS) : [])]) {
    const binary = join(dir, slot, ...file.split('/'))
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, bytes)
    files[file] = sha256Of(binary)
  }
  const relative = IROH_PREBUILD_FILES[slot]
  if (relative) {
    const native = join(dir, slot, relative)
    mkdirSync(dirname(native), { recursive: true })
    writeFileSync(native, nativeBytes(slot, bytes))
    files[relative] = sha256Of(native)
  }
  const manifest = mergeManifest(null, {
    slot,
    version,
    napi: 8,
    nodeHeaders,
    entry: {
      napi: 8,
      files,
      ...(relative ? { iroh: structuredClone(IROH_BUILD_IDENTITY) } : {})
    }
  })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

describe('mergeOrcadPrebuildTrees', () => {
  it('refuses a lane whose files no longer match its own manifest', () => {
    const lane = laneTree('win32-x64')
    writeFileSync(join(lane, 'win32-x64', 'pty.node'), 'tampered')

    expect(() => mergeOrcadPrebuildTrees([lane], join(temp(), 'out'))).toThrow(
      'win32-x64/pty.node: sha256 does not match the manifest'
    )
  })

  it('preserves complete native files and SDK identities from separate host lanes', () => {
    const slots = ['darwin-arm64', 'linux-x64-glibc', 'linux-arm64-glibc', 'linux-x64-glibc217']
    const lanes = slots.map((slot) => laneTree(slot))
    const out = join(temp(), 'out')
    const merged = mergeOrcadPrebuildTrees(lanes, out)
    expect(merged.version).toBe('2.0.0')
    expect(merged.version).not.toBe(IROH_BUILD_IDENTITY.sdkVersion)
    expect(Object.keys(merged.slots).sort()).toEqual([...slots].sort())
    for (const [index, slot] of slots.entries()) {
      const original = readManifest(lanes[index]).slots[slot]
      expect(merged.slots[slot]).toEqual(original)
      for (const relative of Object.keys(original.files)) {
        expect(readFileSync(join(out, slot, relative))).toEqual(
          readFileSync(join(lanes[index], slot, relative))
        )
      }
      if (IROH_PREBUILD_FILES[slot]) {
        expect(merged.slots[slot].iroh).toEqual(IROH_BUILD_IDENTITY)
      }
    }
    expect(readManifest(out)).toEqual(merged)
  })

  it('refuses the same slot from two lanes instead of letting the last one win', () => {
    const out = join(temp(), 'out')
    expect(() =>
      mergeOrcadPrebuildTrees(
        [laneTree('linux-x64-glibc'), laneTree('linux-x64-glibc', { bytes: 'other' })],
        out
      )
    ).toThrow('linux-x64-glibc appears in both')
  })
})
