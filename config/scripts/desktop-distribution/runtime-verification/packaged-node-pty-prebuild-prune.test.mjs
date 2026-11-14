import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prunePackagedNodePty } = require('../../../packaged-runtime-node-modules.cjs')

describe('prunePackagedNodePty: the Windows conpty fallback', () => {
  let resources

  const nodePty = () => join(resources, 'node_modules', 'node-pty')
  const write = (relative, contents = 'x') => {
    const target = join(nodePty(), relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }

  const peAddon = (arch) => {
    const buffer = Buffer.alloc(0x50)
    buffer.write('MZ')
    buffer.writeUInt32LE(0x40, 0x3c)
    buffer.write('PE\0\0', 0x40)
    buffer.writeUInt16LE({ x64: 0x8664, arm64: 0xaa64 }[arch], 0x44)
    return buffer
  }
  const prebuilt = (name) => join(nodePty(), 'prebuilds', 'win32-arm64', name)

  const seedWindowsTree = (buildArch) => {
    write(join('build', 'Release', 'conpty.node'), peAddon(buildArch))
    write(join('third_party', 'conpty', 'v1', 'win10-arm64', 'conpty.dll'))
    write(join('third_party', 'conpty', 'v1', 'win10-arm64', 'OpenConsole.exe'))
    write(join('prebuilds', 'win32-arm64', 'conpty.node'))
    write(join('prebuilds', 'win32-arm64', 'pty.node'))
  }

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'orca-prune-'))
  })
  afterEach(() => {
    rmSync(resources, { recursive: true, force: true })
  })

  it('keeps the fallback when build/Release holds a different arch than the slice', () => {
    seedWindowsTree('x64')

    prunePackagedNodePty(resources, 'win32', 'arm64')

    expect(existsSync(prebuilt('conpty.node'))).toBe(true)
  })

  it('removes the matching-architecture fallback while keeping other prebuilds', () => {
    seedWindowsTree('arm64')

    prunePackagedNodePty(resources, 'win32', 'arm64')

    expect(existsSync(prebuilt('conpty.node'))).toBe(false)
    expect(existsSync(prebuilt('pty.node'))).toBe(true)
  })
})
