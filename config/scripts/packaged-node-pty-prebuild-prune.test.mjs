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
 * build carries Orca's job-object exports, so leaving the prebuild beside it
 * means an ABI mismatch or an AV quarantine silently downgrades the shipped app
 * to a binary that cannot own a PTY tree -- with no error anywhere.
 */
describe('prunePackagedNodePty: the Windows prebuild fallback', () => {
  let resources

  const nodePty = () => join(resources, 'node_modules', 'node-pty')
  const writeFile = (relative) => {
    const target = join(nodePty(), relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'x')
  }

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'orca-prune-'))
  })
  afterEach(() => {
    rmSync(resources, { recursive: true, force: true })
  })

  it('removes the prebuild when the source build is present', () => {
    writeFile(join('build', 'Release', 'conpty.node'))
    writeFile(join('prebuilds', 'win32-x64', 'conpty.node'))
    // The later ConPTY-runtime check expects these; unrelated to the prune.
    writeFile(join('third_party', 'conpty', 'v1', 'win10-x64', 'conpty.dll'))
    writeFile(join('third_party', 'conpty', 'v1', 'win10-x64', 'OpenConsole.exe'))

    prunePackagedNodePty(resources, 'win32', 'x64')

    expect(existsSync(join(nodePty(), 'build', 'Release', 'conpty.node'))).toBe(true)
    expect(existsSync(join(nodePty(), 'prebuilds'))).toBe(false)
  })

  it('keeps the prebuild when there is no source build to prefer', () => {
    // Deleting it here would leave nothing loadable at all.
    writeFile(join('prebuilds', 'win32-x64', 'conpty.node'))

    prunePackagedNodePty(resources, 'win32', 'x64')

    expect(existsSync(join(nodePty(), 'prebuilds', 'win32-x64', 'conpty.node'))).toBe(true)
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64']
  ])('leaves %s prebuilds alone, which have no patched-export requirement', (platform, arch) => {
    writeFile(join('build', 'Release', 'conpty.node'))
    writeFile(join('prebuilds', `${platform}-${arch}`, 'pty.node'))

    prunePackagedNodePty(resources, platform, arch)

    expect(existsSync(join(nodePty(), 'prebuilds', `${platform}-${arch}`, 'pty.node'))).toBe(true)
  })
})
