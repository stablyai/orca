import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWaylandClipboard } from './build-wayland-clipboard.mjs'
import glibcVerification from './verify-linux-glibc-floor.cjs'

const require = createRequire(import.meta.url)
const {
  ensureBundledWaylandClipboard,
  finalizePackagedWaylandClipboard
} = require('../wayland-clipboard-resources.cjs')
const config = require('../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')
let root
let verify

function output(arch = 'x64') {
  return join(root, 'native', 'wayland-clipboard', '.build', arch, 'orca-wayland-clipboard')
}

function writeExecutable(arch) {
  const binary = output(arch)
  mkdirSync(dirname(binary), { recursive: true })
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(glibcVerification.ELF_MACHINE_BY_ARCH[arch], 18)
  writeFileSync(binary, header)
  chmodSync(binary, 0o755)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-wayland-build-'))
  for (const file of [
    'native/wayland-clipboard/wayland-clipboard.c',
    'native/wayland-clipboard/protocol_test.py',
    'native/wayland-clipboard/Dockerfile',
    'config/scripts/build-wayland-clipboard.mjs'
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), file)
  }
  verify = vi.spyOn(glibcVerification, 'verifyLinuxGlibcFloor').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('Wayland clipboard build', () => {
  it.each(['x64', 'arm64'])(
    'builds and validates %s, then reuses only a matching source fingerprint',
    (arch) => {
      const run = vi.fn((_program, args) => {
        if (args[0] === 'run') {
          writeExecutable(arch)
        }
        return { status: 0 }
      })
      expect(buildWaylandClipboard({ root, arch, run })).toBe(output(arch))
      expect(run).toHaveBeenCalledTimes(2)
      expect(verify).toHaveBeenCalledWith(dirname(output(arch)), { targetArch: arch })
      if (process.platform !== 'win32') {
        expect(statSync(output(arch)).mode & 0o111).toBe(0o111)
      }
      buildWaylandClipboard({ root, arch, run })
      expect(run).toHaveBeenCalledTimes(2)
      expect(verify).toHaveBeenCalledTimes(2)
      writeFileSync(join(root, 'native', 'wayland-clipboard', 'protocol_test.py'), 'changed tests')
      buildWaylandClipboard({ root, arch, run })
      expect(run).toHaveBeenCalledTimes(4)
    }
  )

  it('rejects a corrupt cached executable instead of silently passing an empty ELF scan', () => {
    const run = vi.fn((_program, args) => {
      if (args[0] === 'run') {
        writeExecutable('x64')
      }
      return { status: 0 }
    })
    buildWaylandClipboard({ root, arch: 'x64', run })
    writeFileSync(output(), 'not an executable')
    expect(() => buildWaylandClipboard({ root, arch: 'x64', run })).toThrow('ELF executable')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform === 'win32')(
    'restores executable mode when reusing an extracted cached build',
    () => {
      const run = vi.fn((_program, args) => {
        if (args[0] === 'run') {
          writeExecutable('x64')
        }
        return { status: 0 }
      })
      buildWaylandClipboard({ root, arch: 'x64', run })
      chmodSync(output(), 0o644)
      buildWaylandClipboard({ root, arch: 'x64', run })
      expect(statSync(output()).mode & 0o111).toBe(0o111)
      expect(run).toHaveBeenCalledTimes(2)
    }
  )

  it('does not stamp a binary that failed architecture or glibc validation', () => {
    verify.mockImplementation(() => {
      throw new Error('wrong architecture')
    })
    const run = vi.fn((_program, args) => {
      if (args[0] === 'run') {
        writeExecutable('x64')
      }
      return { status: 0 }
    })
    expect(() => buildWaylandClipboard({ root, arch: 'x64', run })).toThrow('wrong architecture')
    expect(existsSync(`${output()}.sha256`)).toBe(false)
  })

  it('removes a stale build before compilation and leaves no stamp on compiler failure', () => {
    writeExecutable('x64')
    writeFileSync(`${output()}.sha256`, 'stale')
    const run = vi.fn((_program, args) => {
      expect(existsSync(output())).toBe(false)
      return { status: args[0] === 'run' ? 1 : 0 }
    })
    expect(() => buildWaylandClipboard({ root, arch: 'x64', run })).toThrow('run failed')
    expect(existsSync(`${output()}.sha256`)).toBe(false)
  })

  it('reports a missing Docker installation', () => {
    expect(() =>
      buildWaylandClipboard({ root, arch: 'x64', run: () => ({ error: new Error('ENOENT') }) })
    ).toThrow('Unable to run Docker')
  })
})

describe('Wayland clipboard packaging', () => {
  it.each([
    [1, 'x64'],
    [3, 'arm64']
  ])('builds and copies only the selected slice %s', async (archEnum, arch) => {
    const run = vi.fn(() => {
      writeExecutable(arch)
      return { status: 0 }
    })
    ensureBundledWaylandClipboard(archEnum, root, run)
    expect(run.mock.calls[0][1]).toEqual([
      join(root, 'config', 'scripts', 'build-wayland-clipboard.mjs'),
      '--arch',
      arch
    ])
    const resource = config.linux.extraResources.find(
      (entry) => entry.to === 'bin/orca-wayland-clipboard'
    )
    const target = join(root, 'packaged', resource.to)
    const source = join(root, resource.from.replace('${arch}', arch))
    await copyFiles([new FileMatcher(source, target, (value) => value, ['**/*'])])
    expect(readFileSync(target)).toEqual(readFileSync(output(arch)))
    chmodSync(target, 0o644)
    finalizePackagedWaylandClipboard(join(root, 'packaged'))
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o111).toBe(0o111)
    }
    for (const platform of ['mac', 'win']) {
      expect(config[platform].extraResources.some((entry) => entry.to === resource.to)).toBe(false)
    }
  })

  it.each(['missing', 'corrupt'])(
    'rejects a %s helper in the actual packaged resources',
    (state) => {
      const resources = join(root, 'resources')
      if (state === 'corrupt') {
        mkdirSync(join(resources, 'bin'), { recursive: true })
        writeFileSync(join(resources, 'bin', 'orca-wayland-clipboard'), 'not ELF')
      }
      expect(() => finalizePackagedWaylandClipboard(resources)).toThrow(
        'missing its Wayland clipboard executable'
      )
    }
  )

  it.each([0, 2])('rejects unsupported packaging architecture %s', (arch) => {
    expect(() => ensureBundledWaylandClipboard(arch, root, vi.fn())).toThrow('Unsupported')
  })

  it.each([0, 1])('rejects a missing output even after build status %s', (status) => {
    expect(() => ensureBundledWaylandClipboard(1, root, () => ({ status }))).toThrow(
      'requires a built'
    )
  })
})
