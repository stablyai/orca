import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeOrcadPrebuildTrees } from './merge-orcad-prebuilds.mjs'
import {
  COMPAT_SLOT_ADDONS,
  findSlotProblems,
  isCompatSlot,
  mergeManifest,
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

/** One CI lane's `out/orcad-prebuilds`: a single slot plus its manifest. */
function laneTree(slot, { version = '1.1.0', nodeHeaders = '24.21.0', bytes = slot } = {}) {
  const dir = temp()
  const files = {}
  // A compat slot also carries its own addons.
  for (const file of ['pty.node', ...(isCompatSlot(slot) ? Object.keys(COMPAT_SLOT_ADDONS) : [])]) {
    const binary = join(dir, slot, ...file.split('/'))
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, bytes)
    files[file] = sha256Of(binary)
  }
  const manifest = mergeManifest(null, {
    slot,
    version,
    napi: 8,
    nodeHeaders,
    entry: { napi: 8, files }
  })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

describe('mergeOrcadPrebuildTrees', () => {
  it('unions one slot per lane into a matrix that --require-slots accepts', () => {
    const out = join(temp(), 'orcad-prebuilds')
    const merged = mergeOrcadPrebuildTrees(
      [laneTree('darwin-arm64'), laneTree('linux-x64-musl'), laneTree('linux-x64-glibc217')],
      out
    )

    expect(Object.keys(merged.slots)).toEqual([
      'darwin-arm64',
      'linux-x64-glibc217',
      'linux-x64-musl'
    ])
    const written = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    expect(findSlotProblems(written, out, Object.keys(merged.slots))).toEqual([])
  })

  it('refuses a lane whose files no longer match its own manifest', () => {
    const lane = laneTree('win32-x64')
    writeFileSync(join(lane, 'win32-x64', 'pty.node'), 'tampered')

    expect(() => mergeOrcadPrebuildTrees([lane], join(temp(), 'out'))).toThrow(
      'win32-x64/pty.node: sha256 does not match the manifest'
    )
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

  it('refuses lanes built against different node-pty or Node headers', () => {
    expect(() =>
      mergeOrcadPrebuildTrees(
        [laneTree('darwin-x64'), laneTree('darwin-arm64', { version: '1.2.0' })],
        join(temp(), 'out')
      )
    ).toThrow('refusing to merge node-pty 1.2.0')
    expect(() =>
      mergeOrcadPrebuildTrees(
        [laneTree('darwin-x64'), laneTree('darwin-arm64', { nodeHeaders: '24.20.0' })],
        join(temp(), 'out')
      )
    ).toThrow('Node 24.20.0 headers')
  })

  it('refuses an empty lane and an output that is also a source', () => {
    expect(() => mergeOrcadPrebuildTrees([temp()], join(temp(), 'out'))).toThrow(
      'holds no prebuild slot manifest'
    )
    const lane = laneTree('darwin-x64')
    expect(() => mergeOrcadPrebuildTrees([lane], lane)).toThrow('both a source and the output')
  })
})
