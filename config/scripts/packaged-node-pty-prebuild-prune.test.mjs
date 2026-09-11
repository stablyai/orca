import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prunePackagedNodePty } = require('../packaged-runtime-node-modules.cjs')

/**
 * node-pty's loader tries build/Release, then build/Debug, then
 * prebuilds/<platform>-<arch>, swallowing failures in between. Only the source
 * build carries Orca's job-object exports, so leaving the prebuilt conpty.node
 * beside it means an ABI mismatch or an AV quarantine silently downgrades the
 * app to a binary that cannot own a PTY tree.
 *
 * The siblings must survive: Orca's patch deletes the `conpty_console_list` and
 * winpty `pty` gyp targets, so those binaries exist nowhere but here.
 */
describe('prunePackagedNodePty: the Windows conpty fallback', () => {
  let resources
  const HOST_ARCH = process.arch

  const nodePty = () => join(resources, 'node_modules', 'node-pty')
  const write = (relative, contents = 'x') => {
    const target = join(nodePty(), relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }

  /** Minimal PE far enough to carry a `Machine`, which is what the prune now reads. */
  const PE_MACHINE_BY_ARCH = { x64: 0x8664, arm64: 0xaa64 }
  const peAddon = (arch) => {
    const buffer = Buffer.alloc(0x50)
    buffer.write('MZ')
    buffer.writeUInt32LE(0x40, 0x3c)
    buffer.write('PE\0\0', 0x40)
    buffer.writeUInt16LE(PE_MACHINE_BY_ARCH[arch], 0x44)
    return buffer
  }
  const prebuilt = (name, arch = HOST_ARCH) => join(nodePty(), 'prebuilds', `win32-${arch}`, name)

  /** What a real packaged win32 prebuilds/<arch> directory holds. */
  const SIBLINGS = ['conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']

  /** `buildArch` is what build/Release actually holds, which is not always the slice's arch. */
  const seedWindowsTree = (arch = HOST_ARCH, buildArch = arch) => {
    write(join('build', 'Release', 'conpty.node'), peAddon(buildArch))
    write(join('third_party', 'conpty', 'v1', `win10-${arch}`, 'conpty.dll'))
    write(join('third_party', 'conpty', 'v1', `win10-${arch}`, 'OpenConsole.exe'))
    write(join('prebuilds', `win32-${arch}`, 'conpty.node'))
    for (const sibling of SIBLINGS) {
      write(join('prebuilds', `win32-${arch}`, sibling))
    }
  }

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'orca-prune-'))
  })
  afterEach(() => {
    rmSync(resources, { recursive: true, force: true })
  })

  it('removes the stale conpty fallback when the source build is present', () => {
    seedWindowsTree()

    prunePackagedNodePty(resources, 'win32', HOST_ARCH)

    expect(existsSync(join(nodePty(), 'build', 'Release', 'conpty.node'))).toBe(true)
    expect(existsSync(prebuilt('conpty.node'))).toBe(false)
  })

  it.each(SIBLINGS)('keeps %s, which exists nowhere else in a packaged build', (sibling) => {
    // Orca's patch removes the conpty_console_list and winpty gyp targets, so a
    // Windows source build never produces these. Deleting them kills console
    // membership silently and breaks PTY spawn below Windows build 18309.
    seedWindowsTree()

    prunePackagedNodePty(resources, 'win32', HOST_ARCH)

    expect(existsSync(prebuilt(sibling))).toBe(true)
  })

  it('keeps the fallback when there is no source build to prefer', () => {
    write(join('prebuilds', `win32-${HOST_ARCH}`, 'conpty.node'))
    write(join('third_party', 'conpty', 'v1', `win10-${HOST_ARCH}`, 'conpty.dll'))
    write(join('third_party', 'conpty', 'v1', `win10-${HOST_ARCH}`, 'OpenConsole.exe'))

    prunePackagedNodePty(resources, 'win32', HOST_ARCH)

    expect(existsSync(prebuilt('conpty.node'))).toBe(true)
  })

  it('keeps the fallback when build/Release holds a different arch than the slice', () => {
    // A cross-HOST package can copy a build/Release that the target cannot load;
    // deleting the prebuild would remove the only binary the shipped app has.
    const target = HOST_ARCH === 'arm64' ? 'x64' : 'arm64'
    seedWindowsTree(target, HOST_ARCH)

    prunePackagedNodePty(resources, 'win32', target)

    expect(existsSync(prebuilt('conpty.node', target))).toBe(true)
  })

  it('removes the fallback on a cross-arch package whose build/Release IS the slice arch', () => {
    // Measured on Windows: `electron-builder --win --arm64` on an x64 host does
    // cross-rebuild a correct arm64 addon. Keying off the host arch skipped this
    // case, so the slice shipped the unpatched prebuild as a live fallback.
    const target = HOST_ARCH === 'arm64' ? 'x64' : 'arm64'
    seedWindowsTree(target, target)

    prunePackagedNodePty(resources, 'win32', target)

    expect(existsSync(prebuilt('conpty.node', target))).toBe(false)
    expect(existsSync(prebuilt('pty.node', target))).toBe(true)
  })

  it('keeps the fallback when build/Release is not a readable PE at all', () => {
    seedWindowsTree()
    write(join('build', 'Release', 'conpty.node'), 'not-a-pe')

    prunePackagedNodePty(resources, 'win32', HOST_ARCH)

    expect(existsSync(prebuilt('conpty.node'))).toBe(true)
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64']
  ])('leaves %s prebuilds alone', (platform, arch) => {
    write(join('build', 'Release', 'conpty.node'), peAddon('x64'))
    write(join('prebuilds', `${platform}-${arch}`, 'pty.node'))

    prunePackagedNodePty(resources, platform, arch)

    expect(existsSync(join(nodePty(), 'prebuilds', `${platform}-${arch}`, 'pty.node'))).toBe(true)
  })
})
