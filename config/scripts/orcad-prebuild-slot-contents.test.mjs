import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertCompatSlotHost,
  COMPAT_SLOT_ADDONS,
  COMPAT_SLOTS,
  findCompatAddonGaps,
  findPostBaselineNodeApiNames,
  findSharedCxxRuntimeNeeds,
  findSlotProblems,
  highestGlibcNeed,
  isCompatSlot,
  mergeManifest,
  prebuildCompileGypi,
  sha256Of,
  slotGlibcFloor,
  slotSourceFiles,
  SLOT_NAPI_VERSION,
  windowsConptyRuntimeDir
} from './orcad-prebuild-slot-contents.mjs'
import {
  ORCAD_ADDON_NAPI_VERSION,
  orcadTemplateTargetFilenames
} from '../../src/shared/orcad-artifacts.ts'

const floors = createRequire(import.meta.url)('./verify-linux-glibc-floor.cjs')
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

describe('N-API pinning', () => {
  it('pins N-API 8 so a host Node 18 (rung C) can load every slot', () => {
    expect(SLOT_NAPI_VERSION).toBe(8)
    // The client's rung C host-Node gate must ask for exactly what the slots are built against.
    expect(ORCAD_ADDON_NAPI_VERSION).toBe(SLOT_NAPI_VERSION)
    expect(JSON.parse(prebuildCompileGypi()).target_defaults.defines).toEqual(['NAPI_VERSION=8'])
  })

  it('pins the macOS C++ standard that the headers config.gypi (clang: 0) would skip', () => {
    expect(JSON.parse(prebuildCompileGypi()).target_defaults.conditions).toEqual([
      [
        'OS=="mac"',
        { xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'gnu++20', CLANG_CXX_LIBRARY: 'libc++' } }
      ]
    ])
  })

  it('links the C++ runtime statically only when asked', () => {
    const conditions = (options) =>
      JSON.parse(prebuildCompileGypi(options)).target_defaults.conditions
    expect(conditions({ staticCxxRuntime: false })).toHaveLength(1)
    expect(conditions({ staticCxxRuntime: true })).toContainEqual([
      'OS=="linux"',
      { ldflags: ['-static-libstdc++', '-static-libgcc'] }
    ])
    expect(JSON.parse(prebuildCompileGypi({ napi: 9 })).target_defaults.defines).toEqual([
      'NAPI_VERSION=9'
    ])
  })

  it('flags node_api_* imports but not the module version export', () => {
    const binary = Buffer.from(
      '\0_napi_register_module_v1\0_node_api_module_get_api_version_v1\0napi_create_object\0'
    )
    expect(findPostBaselineNodeApiNames(binary)).toEqual([])
    const newer = Buffer.concat([binary, Buffer.from('node_api_symbol_for\0')])
    expect(findPostBaselineNodeApiNames(newer)).toEqual(['node_api_symbol_for'])
  })
})

describe('glibc floors per slot', () => {
  it('gates default glibc slots at 2.28 and the compat slot at 2.17, never the desktop 2.31', () => {
    expect(slotGlibcFloor('linux-x64-glibc')).toBe(floors.SERVER_SLOT_GLIBC_FLOOR)
    expect(slotGlibcFloor('linux-arm64-glibc')).toBe(floors.SERVER_SLOT_GLIBC_FLOOR)
    expect(slotGlibcFloor('linux-x64-glibc217')).toBe(floors.COMPAT_SLOT_GLIBC_FLOOR)
    expect(floors.SERVER_SLOT_GLIBC_FLOOR.families[0]).toEqual({ prefix: 'GLIBC_', floor: [2, 28] })
    expect(floors.COMPAT_SLOT_GLIBC_FLOOR.families[0]).toEqual({ prefix: 'GLIBC_', floor: [2, 17] })
  })

  it('keeps the compat slot out of the default matrix', () => {
    expect(Object.keys(COMPAT_SLOTS)).toEqual(['linux-x64-glibc217'])
    expect(isCompatSlot('linux-x64-glibc217')).toBe(true)
    expect(isCompatSlot('linux-x64-glibc')).toBe(false)
    expect(isCompatSlot('toString')).toBe(false)
  })

  it('refuses the compat label on a host that cannot build it', () => {
    const host = { platform: 'linux', arch: 'x64', libc: 'glibc' }
    expect(() => assertCompatSlotHost('linux-x64-glibc217', host)).not.toThrow()
    expect(() => assertCompatSlotHost('linux-x64-glibc217', { ...host, arch: 'arm64' })).toThrow(
      'linux-x64-glibc217 must be built on linux-x64-glibc, not linux-arm64-glibc'
    )
    expect(() => assertCompatSlotHost('linux-x64-glibc217', { ...host, libc: 'musl' })).toThrow()
    expect(() => assertCompatSlotHost('linux-arm64-musl', { ...host, libc: 'musl' })).not.toThrow()
  })

  it('names shared C++ runtime needs a static compat slot must not have', () => {
    expect(
      findSharedCxxRuntimeNeeds(
        new Set(['libc.so.6', 'libstdc++.so.6', 'libutil.so.1', 'libgcc_s.so.1'])
      )
    ).toEqual(['libgcc_s.so.1', 'libstdc++.so.6'])
    expect(findSharedCxxRuntimeNeeds(new Set(['libc.so.6', 'libutil.so.1']))).toEqual([])
  })
})

describe('slotSourceFiles', () => {
  it('ships pty.node everywhere POSIX and spawn-helper only on macOS', () => {
    const names = (platform) =>
      slotSourceFiles({ platform, arch: 'x64', buildDir: '/b', nodePtyDir: '/p' }).map(([f]) => f)
    expect(names('linux')).toEqual(['pty.node'])
    expect(names('darwin')).toEqual(['pty.node', 'spawn-helper'])
  })

  it('ships conpty.node with the vendored ConPTY runtime and console-list module on Windows', () => {
    const nodePtyDir = temp()
    mkdirSync(join(nodePtyDir, 'third_party', 'conpty', '1.23.251008001', 'win10-arm64'), {
      recursive: true
    })
    const files = slotSourceFiles({ platform: 'win32', arch: 'arm64', buildDir: '/b', nodePtyDir })
    expect(files.map(([file]) => file)).toEqual([
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe'
    ])
    expect(files[2][1]).toBe(
      join(nodePtyDir, 'third_party', 'conpty', '1.23.251008001', 'win10-arm64', 'conpty.dll')
    )
  })

  it('refuses an ambiguous or absent ConPTY payload rather than picking one', () => {
    const nodePtyDir = temp()
    expect(() => windowsConptyRuntimeDir(nodePtyDir, 'x64')).toThrow(/found 0/)
    for (const version of ['1.22.0', '1.23.0']) {
      mkdirSync(join(nodePtyDir, 'third_party', 'conpty', version, 'win10-x64'), {
        recursive: true
      })
    }
    expect(() => windowsConptyRuntimeDir(nodePtyDir, 'x64')).toThrow(/found 2/)
  })
})

describe('highestGlibcNeed', () => {
  it('takes the highest strong GLIBC_ need and ignores weak and libstdc++ needs', () => {
    const needs = {
      a: [
        { name: 'GLIBC_2.17', weak: false },
        { name: 'GLIBC_2.34', weak: true },
        { name: 'GLIBCXX_3.4.28', weak: false }
      ],
      b: [{ name: 'GLIBC_2.2.5', weak: false }]
    }
    expect(highestGlibcNeed(['a', 'b'], (path) => needs[path])).toBe('2.17')
    expect(highestGlibcNeed([], () => [])).toBeNull()
  })
})

describe('mergeManifest', () => {
  it('accumulates slots across the per-runner CI builds', () => {
    // Overwriting would erase every other runner's record, and the release gate would then
    // reject a matrix that is actually complete.
    const first = mergeManifest(null, next('linux-x64-glibc'))
    const second = mergeManifest(first, next('darwin-arm64'))
    expect(Object.keys(second.slots)).toEqual(['darwin-arm64', 'linux-x64-glibc'])
    expect(second).toMatchObject({ schemaVersion: 2, module: 'node-pty', napi: 8 })
  })

  it('replaces a slot rebuilt twice instead of duplicating it', () => {
    const once = mergeManifest(null, next('darwin-arm64'))
    const twice = mergeManifest(once, next('darwin-arm64', { entry: entry({ 'pty.node': 'b' }) }))
    expect(twice.slots['darwin-arm64'].files).toEqual({ 'pty.node': 'b' })
  })

  it('refuses to merge builds of different N-API levels or node-pty versions', () => {
    const once = mergeManifest(null, next('darwin-arm64'))
    expect(() => mergeManifest(once, next('win32-x64', { napi: 9 }))).toThrow(/refusing to merge/)
    expect(() => mergeManifest(once, next('win32-x64', { version: '1.2.0' }))).toThrow(
      /refusing to merge/
    )
  })

  it('drops a schema 1 manifest rather than mixing its ABI-gated slots in', () => {
    const merged = mergeManifest({ nodeAbi: '127', slots: ['linux-x64-glibc'] }, next('win32-x64'))
    expect(Object.keys(merged.slots)).toEqual(['win32-x64'])
  })
})

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

  it('refuses a compat slot missing one of its own addons', () => {
    const dir = temp()
    const slot = 'linux-x64-glibc217'
    mkdirSync(join(dir, slot))
    writeFileSync(join(dir, slot, 'pty.node'), 'binary')
    const manifest = mergeManifest(
      null,
      next(slot, { entry: entry({ 'pty.node': sha256Of(join(dir, slot, 'pty.node')) }) })
    )
    expect(findSlotProblems(manifest, dir, [slot])).toEqual([
      `${slot}/parcel-watcher/watcher.node: not built`
    ])
  })
})

describe('compat addon coverage', () => {
  const nodePtySources = (target) =>
    orcadTemplateTargetFilenames(target).filter((file) => file.includes('node-pty/build/Release/'))

  it('gives every native addon a compat target ships a compat build', () => {
    for (const compat of Object.keys(COMPAT_SLOTS)) {
      const sources = new Set([...nodePtySources(compat), ...Object.values(COMPAT_SLOT_ADDONS)])
      expect(findCompatAddonGaps(orcadTemplateTargetFilenames(compat), sources)).toEqual([])
    }
  })

  it('names a native file that would ship as the base target build', () => {
    const target = 'linux-x64-glibc217'
    expect(
      findCompatAddonGaps(orcadTemplateTargetFilenames(target), new Set(nodePtySources(target)))
    ).toEqual(['node_modules/@parcel/watcher/watcher.node'])
  })
})
