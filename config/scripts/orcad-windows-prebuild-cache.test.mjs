import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { sha256Of } from './orcad-prebuild-slot-contents.mjs'
import {
  validateWindowsPrebuildCache,
  windowsPrebuildCacheIdentity,
  WINDOWS_PREBUILD_CACHE_INPUTS
} from './orcad-windows-prebuild-cache.mjs'
import { peImage } from './windows-pe-image-fixture.mjs'

const require = createRequire(import.meta.url)
const { CYGWIN_BREAKAWAY_MARKER } = require('./node-pty-job-ownership.cjs')
const temporary = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(arch = 'x64') {
  const dir = mkdtempSync(join(tmpdir(), 'orca-windows-prebuild-cache-'))
  temporary.push(dir)
  const sourceDir = join(dir, 'source')
  const prebuildsDir = join(dir, 'prebuilds')
  const slot = `win32-${arch}`
  const slotDir = join(prebuildsDir, slot)
  const write = (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  write(join(sourceDir, 'package.json'), '{"version":"1.1.0"}')
  write(join(sourceDir, 'binding.gyp'), '--no-as-needed,-l:libutil.so.1')
  write(join(sourceDir, 'src/unix/pty.cc'), '.symver openpty,openpty@')
  write(join(sourceDir, 'src/win/conpty.cc'), 'L"msys-2.0.dll"')
  mkdirSync(join(sourceDir, 'third_party/conpty/1', `win10-${arch}`), { recursive: true })
  const files = {}
  for (const [file, bytes] of [
    ['conpty.node', Buffer.concat([peImage({ arch }), CYGWIN_BREAKAWAY_MARKER])],
    ['conpty_console_list.node', peImage({ arch })],
    ['conpty/conpty.dll', peImage({ arch })],
    ['conpty/OpenConsole.exe', peImage({ arch })]
  ]) {
    write(join(slotDir, file), bytes)
    files[file] = sha256Of(join(slotDir, file))
    if (file === 'conpty_console_list.node') {
      write(join(sourceDir, 'prebuilds', slot, file), bytes)
    }
    if (file.startsWith('conpty/')) {
      write(
        join(sourceDir, 'third_party/conpty/1', `win10-${arch}`, file.slice('conpty/'.length)),
        bytes
      )
    }
  }
  const entry = { platform: 'win32', arch, libc: 'none', glibc: null, napi: 8, files }
  const manifest = {
    schemaVersion: 2,
    module: 'node-pty',
    version: '1.1.0',
    napi: 8,
    nodeHeaders: NODE_RUNTIME_PIN.version,
    slots: { [slot]: entry }
  }
  const save = () => writeFileSync(join(prebuildsDir, 'manifest.json'), JSON.stringify(manifest))
  save()
  return { sourceDir, prebuildsDir, slot, slotDir, entry, manifest, save, platform: 'win32', arch }
}

describe('Windows server prebuild cache validation', () => {
  it.each(['x64', 'arm64'])('accepts a complete current %s payload', (arch) => {
    const f = fixture(arch)
    expect(validateWindowsPrebuildCache(f)).toBe(f.slot)
    expect(() => validateWindowsPrebuildCache({ ...f, platform: 'linux' })).toThrow(
      /requires win32/
    )
  })

  it.each([
    ['module', 'upstream'],
    ['version', '0.0.0'],
    ['napi', 10],
    ['nodeHeaders', '24.0.0'],
    ['schemaVersion', 1]
  ])('refuses a changed manifest %s', (field, value) => {
    const f = fixture()
    f.manifest[field] = value
    f.save()
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/manifest does not match/)
  })

  it.each([
    ['arch', 'arm64'],
    ['platform', 'linux'],
    ['libc', 'glibc'],
    ['glibc', '2.28'],
    ['napi', 10]
  ])('refuses a changed slot %s', (field, value) => {
    const f = fixture()
    f.entry[field] = value
    f.save()
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/metadata does not match/)
  })

  it('refuses missing, extra and unlisted payloads before trusting their hashes', () => {
    const f = fixture()
    delete f.entry.files['conpty/conpty.dll']
    f.save()
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/exactly the current ConPTY payload/)
    const extra = fixture()
    writeFileSync(join(extra.slotDir, 'pty.node'), 'upstream fallback')
    expect(() => validateWindowsPrebuildCache(extra)).toThrow(/exactly the current ConPTY payload/)
    const missing = fixture()
    rmSync(join(missing.slotDir, 'conpty/OpenConsole.exe'))
    expect(() => validateWindowsPrebuildCache(missing)).toThrow(
      /exactly the current ConPTY payload/
    )
  })

  it('refuses modified bytes even when the file inventory is complete', () => {
    const f = fixture()
    writeFileSync(join(f.slotDir, 'conpty/conpty.dll'), 'tampered')
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/sha256 does not match/)
  })

  it('refuses unexpected empty directories and payload symlinks', () => {
    const f = fixture()
    mkdirSync(join(f.slotDir, 'upstream'))
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/exactly the current ConPTY payload/)
    rmSync(join(f.slotDir, 'upstream'), { recursive: true })
    const path = join(f.slotDir, 'conpty.node')
    const target = join(f.prebuildsDir, 'outside.node')
    cpSync(path, target)
    rmSync(path)
    symlinkSync(target, path)
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/cannot contain symlinks/)
  })

  it('compares vendored payload bytes with the current installed dependency', () => {
    const f = fixture()
    writeFileSync(
      join(f.sourceDir, 'third_party/conpty/1/win10-x64/conpty.dll'),
      'different vendor payload'
    )
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/differs from the current vendored/)
  })

  it.each([
    [
      'wrong PE architecture',
      Buffer.concat([peImage({ arch: 'arm64' }), CYGWIN_BREAKAWAY_MARKER]),
      /targets win32-x64/
    ],
    ['old breakaway policy', peImage({ arch: 'x64' }), /predates the Cygwin/],
    [
      'post-baseline N-API import',
      Buffer.concat([
        peImage({ arch: 'x64' }),
        CYGWIN_BREAKAWAY_MARKER,
        Buffer.from('node_api_symbol_for')
      ]),
      /above N-API 8/
    ]
  ])('refuses %s even with a matching cached digest', (_name, bytes, error) => {
    const f = fixture()
    writeFileSync(join(f.slotDir, 'conpty.node'), bytes)
    f.entry.files['conpty.node'] = sha256Of(join(f.slotDir, 'conpty.node'))
    f.save()
    expect(() => validateWindowsPrebuildCache(f)).toThrow(error)
  })

  it('checks both current source guards independently of cached payload bytes', () => {
    const f = fixture()
    writeFileSync(join(f.sourceDir, 'src/win/conpty.cc'), 'upstream')
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/source.*does not carry/)
    writeFileSync(join(f.sourceDir, 'src/win/conpty.cc'), 'L"msys-2.0.dll"')
    writeFileSync(join(f.sourceDir, 'binding.gyp'), 'upstream')
    expect(() => validateWindowsPrebuildCache(f)).toThrow(/patch is not applied/)
  })
})

describe('Windows server prebuild cache inputs', () => {
  const options = { platform: 'win32', arch: 'x64', imageOS: 'win22', imageVersion: '20260927.1.0' }

  it('separates host architecture and compiler image without fallback keys', () => {
    const identity = windowsPrebuildCacheIdentity(options)
    expect(identity.key).toMatch(/^orcad-windows-prebuild-v1-win32-x64-[a-f0-9]{64}$/)
    expect(windowsPrebuildCacheIdentity(options)).toEqual(identity)
    for (const override of [
      { arch: 'arm64' },
      { imageOS: 'win11' },
      { imageVersion: '20261001.1.0' }
    ]) {
      expect(windowsPrebuildCacheIdentity({ ...options, ...override }).key).not.toBe(identity.key)
    }
    expect(() => windowsPrebuildCacheIdentity({ ...options, imageVersion: '' })).toThrow(
      /ImageVersion/
    )
  })

  it('covers the bundled compiler-spawn implementation', () => {
    expect(WINDOWS_PREBUILD_CACHE_INPUTS).toEqual(
      expect.arrayContaining(
        [
          'run-process',
          'spawn-resolution',
          'process-tree-termination',
          'process-tree-kill-gate',
          'spawn-observer',
          'bounded-output-sink',
          'child-termination-reporter',
          'process-spec',
          'windows-command-line',
          'windows-cmd-shim-resolution'
        ].map((name) => `src/shared/child-process/${name}.ts`)
      )
    )
  })

  it.each(WINDOWS_PREBUILD_CACHE_INPUTS)('invalidates a changed %s input', (file) => {
    const repository = mkdtempSync(join(tmpdir(), 'orca-prebuild-key-'))
    temporary.push(repository)
    const source = resolve(import.meta.dirname, '../..')
    for (const relative of WINDOWS_PREBUILD_CACHE_INPUTS) {
      mkdirSync(dirname(join(repository, relative)), { recursive: true })
      cpSync(join(source, relative), join(repository, relative))
    }
    const before = windowsPrebuildCacheIdentity({ ...options, repository }).key
    writeFileSync(
      join(repository, file),
      `${readFileSync(join(repository, file), 'utf8')}\nchanged input`
    )
    expect(windowsPrebuildCacheIdentity({ ...options, repository }).key).not.toBe(before)
  })
})
