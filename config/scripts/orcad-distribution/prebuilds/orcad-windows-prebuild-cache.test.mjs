import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RUNTIME_PIN } from '../../../../src/shared/node-runtime-pin.ts'
import { sha256Of } from './orcad-prebuild-slot-contents.mjs'
import { validateWindowsPrebuildCache } from './orcad-windows-prebuild-cache.mjs'
import { peImage } from '../../native-build/windows/windows-pe-image-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  CYGWIN_BREAKAWAY_MARKER,
  NATIVE_HOST_JOB_MARKER
} = require('../../native-build/node-addons/node-pty-job-ownership.cjs')
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
  write(join(sourceDir, 'src/win/conpty.cc'), 'L"msys-2.0.dll"; "assignCurrentProcessToStrictJob"')
  mkdirSync(join(sourceDir, 'third_party/conpty/1', `win10-${arch}`), { recursive: true })
  const files = {}
  for (const [file, bytes] of [
    [
      'conpty.node',
      Buffer.concat([peImage({ arch }), CYGWIN_BREAKAWAY_MARKER, NATIVE_HOST_JOB_MARKER])
    ],
    ['conpty_console_list.node', peImage({ arch })],
    ['conpty/conpty.dll', peImage({ arch })],
    ['conpty/OpenConsole.exe', peImage({ arch })],
    ['pty.node', peImage({ arch })],
    ['winpty.dll', peImage({ arch })],
    ['winpty-agent.exe', peImage({ arch })]
  ]) {
    write(join(slotDir, file), bytes)
    files[file] = sha256Of(join(slotDir, file))
    if (file !== 'conpty.node' && !file.startsWith('conpty/')) {
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
})
