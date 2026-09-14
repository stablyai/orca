import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNodePtyPatchApplied,
  detectLibc,
  MATRIX_SLOTS,
  mergeManifest,
  readManifest,
  slotName
} from './build-orcad-prebuilds.mjs'

const PATCHED_BINDING_GYP =
  "'ldflags': ['-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed']"
const PATCHED_PTY_CC = '__asm__(".symver openpty,openpty@" ORCA_GLIBC_COMPAT_VERSION);'

const dirs = []
const stage = (bindingGyp, ptyCc) => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-src-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src', 'unix'), { recursive: true })
  writeFileSync(join(dir, 'binding.gyp'), bindingGyp)
  writeFileSync(join(dir, 'src', 'unix', 'pty.cc'), ptyCc)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('assertNodePtyPatchApplied', () => {
  it('accepts a tree with both halves of the glibc-floor fix', () => {
    expect(() =>
      assertNodePtyPatchApplied(stage(PATCHED_BINDING_GYP, PATCHED_PTY_CC))
    ).not.toThrow()
  })

  it('refuses to build when the ldflags half is missing', () => {
    // The .symver pins alone let gcc's --as-needed drop libutil/libpthread from
    // DT_NEEDED, which loads on the build host and fails on Ubuntu 20.04 — #9902 again,
    // this time baked into a shipped prebuilt.
    expect(() => assertNodePtyPatchApplied(stage("'ldflags': []", PATCHED_PTY_CC))).toThrow(
      /--no-as-needed,-l:libutil\.so\.1/
    )
  })

  it('refuses to build when the .symver pins are missing', () => {
    expect(() => assertNodePtyPatchApplied(stage(PATCHED_BINDING_GYP, '// upstream'))).toThrow(
      /\.symver glibc pins/
    )
  })

  it('names the patch and the doc so the fix is findable', () => {
    expect(() => assertNodePtyPatchApplied(stage("'ldflags': []", '// upstream'))).toThrow(
      /config\/patches\/node-pty@1\.1\.0\.patch/
    )
  })
})

describe('slot naming', () => {
  it('covers every platform orcad ships to', () => {
    expect([...MATRIX_SLOTS].sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64-glibc',
      'linux-arm64-musl',
      'linux-x64-glibc',
      'linux-x64-musl'
    ])
  })

  it('lets CI force the label so the container decides glibc vs musl', () => {
    // Detection inside a container that happens to run a differently-linked Node would
    // file the build under the wrong slot. The forced label must beat detection outright,
    // so assert against one detection could never produce for this platform/arch.
    expect(slotName(['node', 'x', '--slot=linux-x64-glibc'], 'linux', 'arm64')).toBe(
      'linux-x64-glibc'
    )
  })

  it('omits the libc dimension off Linux', () => {
    expect(slotName([], 'darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('reads glibc from the report header and musl from its absence', () => {
    expect(detectLibc('linux', { glibcVersionRuntime: '2.31' })).toBe('glibc')
    expect(detectLibc('linux', {})).toBe('musl')
    expect(detectLibc('darwin', { glibcVersionRuntime: '2.31' })).toBe('none')
  })
})

describe('mergeManifest', () => {
  it('accumulates slots across the per-container CI runs that build them', () => {
    // Overwriting would erase every other container's record, and the release gate would
    // then reject a matrix that is actually complete.
    const first = mergeManifest(null, { slot: 'linux-x64-glibc', version: '1.1.0', nodeAbi: '127' })
    const second = mergeManifest(first, {
      slot: 'linux-arm64-musl',
      version: '1.1.0',
      nodeAbi: '127'
    })

    expect(second.slots).toEqual(['linux-arm64-musl', 'linux-x64-glibc'])
    expect(second).toMatchObject({ module: 'node-pty', version: '1.1.0', nodeAbi: '127' })
  })

  it('does not duplicate a slot rebuilt twice', () => {
    const once = mergeManifest(null, { slot: 'darwin-arm64', version: '1.1.0', nodeAbi: '127' })
    expect(
      mergeManifest(once, { slot: 'darwin-arm64', version: '1.1.0', nodeAbi: '127' }).slots
    ).toEqual(['darwin-arm64'])
  })
})

describe('readManifest', () => {
  it('returns null instead of throwing when no matrix has been built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-manifest-'))
    dirs.push(dir)
    expect(readManifest(dir)).toBeNull()
  })
})
