import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prunePackagedNodePty } = require('../packaged-runtime-node-modules.cjs')
const { PE_MACHINE } = require('./windows-pe-machine.cjs')

// Loader swallows build/Release/Debug failures and falls back to prebuilds; upstream conpty lacks job ownership, so ABI/AV failures must not silently downgrade it.
// Preserve conpty_console_list and winpty siblings: the patch removes their build targets, leaving only upstream copies.
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
  const peAddon = (arch) => {
    const buffer = Buffer.alloc(0x50)
    buffer.write('MZ')
    buffer.writeUInt32LE(0x40, 0x3c)
    buffer.write('PE\0\0', 0x40)
    buffer.writeUInt16LE(PE_MACHINE[arch], 0x44)
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
    // Keep console-list/winpty prebuilds: patch removes their targets; deleting them breaks membership and PTY spawn below Windows 18309.
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
    // Cross-host build/Release can be unloadable on target; pruning then deletes its only usable binary.
    const target = HOST_ARCH === 'arm64' ? 'x64' : 'arm64'
    seedWindowsTree(target, HOST_ARCH)

    prunePackagedNodePty(resources, 'win32', target)

    expect(existsSync(prebuilt('conpty.node', target))).toBe(true)
  })

  it('removes the fallback on a cross-arch package whose build/Release IS the slice arch', () => {
    // Cross-arch electron-builder can rebuild correctly; judge binary architecture, not host, or arm64 slice keeps unsafe upstream fallback.
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
