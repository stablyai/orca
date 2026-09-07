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
  const write = (relative) => {
    const target = join(nodePty(), relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'x')
  }
  const prebuilt = (name, arch = HOST_ARCH) => join(nodePty(), 'prebuilds', `win32-${arch}`, name)

  /** What a real packaged win32 prebuilds/<arch> directory holds. */
  const SIBLINGS = ['conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']

  const seedWindowsTree = (arch = HOST_ARCH) => {
    write(join('build', 'Release', 'conpty.node'))
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

  it('keeps the fallback on a cross-arch package, where build/Release is the host arch', () => {
    // electron-builder --win --arm64 on an x64 host copies an x64
    // build/Release; deleting the arm64 prebuild would remove the only binary
    // the shipped app could load.
    const target = HOST_ARCH === 'arm64' ? 'x64' : 'arm64'
    seedWindowsTree(target)

    prunePackagedNodePty(resources, 'win32', target)

    expect(existsSync(prebuilt('conpty.node', target))).toBe(true)
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64']
  ])('leaves %s prebuilds alone', (platform, arch) => {
    write(join('build', 'Release', 'conpty.node'))
    write(join('prebuilds', `${platform}-${arch}`, 'pty.node'))

    prunePackagedNodePty(resources, platform, arch)

    expect(existsSync(join(nodePty(), 'prebuilds', `${platform}-${arch}`, 'pty.node'))).toBe(true)
  })
})
