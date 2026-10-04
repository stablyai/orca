import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNodePtyPatchApplied,
  bindingGypForLibc,
  ptySourceForLibc,
  detectLibc,
  MATRIX_SLOTS,
  readManifest,
  requestedSlots,
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
      'linux-x64-musl',
      'win32-arm64',
      'win32-x64'
    ])
  })

  it('requires the whole matrix by default and only the named slots otherwise', () => {
    expect(requestedSlots(['node', 'x'])).toBeNull()
    expect(requestedSlots(['node', 'x', '--require-slots'])).toEqual(MATRIX_SLOTS)
    expect(requestedSlots(['node', 'x', '--require-slots', 'darwin-arm64'])).toEqual([
      'darwin-arm64'
    ])
    expect(requestedSlots(['node', 'x', '--require-slots=win32-x64,win32-arm64'])).toEqual([
      'win32-x64',
      'win32-arm64'
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

describe('bindingGypForLibc', () => {
  const gyp =
    "'ldflags': [\n  '-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed'\n]"

  it('keeps the glibc DT_NEEDED ldflag everywhere but musl', () => {
    expect(bindingGypForLibc(gyp, 'glibc')).toBe(gyp)
    expect(bindingGypForLibc(gyp, 'none')).toBe(gyp)
  })

  it('drops it on musl, which has no libutil.so.1 to link', () => {
    expect(bindingGypForLibc(gyp, 'musl')).not.toContain('libutil.so.1')
  })

  it('matches the binding.gyp the installed patch produces', () => {
    const require = createRequire(import.meta.url)
    const installed = readFileSync(
      join(dirname(require.resolve('node-pty/package.json')), 'binding.gyp'),
      'utf8'
    )
    expect(bindingGypForLibc(installed, 'musl')).not.toContain('-l:libutil.so.1')
  })

  it('fails loudly if the patch stops carrying the flag it strips', () => {
    expect(() => bindingGypForLibc("'ldflags': []", 'musl')).toThrow(/no longer carries/)
  })
})

describe('ptySourceForLibc', () => {
  const source =
    '#if defined(__linux__)\n#  if defined(__x86_64__)\n#    define ORCA_GLIBC_COMPAT_VERSION "GLIBC_2.2.5"\n'

  it('keeps the glibc .symver pins everywhere but musl', () => {
    expect(ptySourceForLibc(source, 'glibc')).toBe(source)
    expect(ptySourceForLibc(source, 'none')).toBe(source)
  })

  it('scopes them to glibc on musl, whose libc has no GLIBC_ versions to bind', () => {
    expect(ptySourceForLibc(source, 'musl')).toMatch(
      /^#if defined\(__linux__\) && defined\(__GLIBC__\)\n/
    )
  })

  it('matches the pty.cc the installed patch produces', () => {
    const require = createRequire(import.meta.url)
    const installed = readFileSync(
      join(dirname(require.resolve('node-pty/package.json')), 'src', 'unix', 'pty.cc'),
      'utf8'
    )
    expect(ptySourceForLibc(installed, 'musl')).toContain('defined(__GLIBC__)')
  })

  it('fails loudly if the patch stops carrying the guard it scopes', () => {
    expect(() => ptySourceForLibc('int main() {}', 'musl')).toThrow(/no longer carries/)
  })
})

describe('readManifest', () => {
  it('returns null instead of throwing when no matrix has been built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-manifest-'))
    dirs.push(dir)
    expect(readManifest(dir)).toBeNull()
  })
})
