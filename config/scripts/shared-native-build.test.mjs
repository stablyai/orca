import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkNativeBuildDirArtifacts, ensureSharedNativeBuild } from './shared-native-build.mjs'
import { peImage } from './windows-pe-image-fixture.mjs'

const roots = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true })
  }
})

function makePackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-shared-native-'))
  roots.push(root)
  return realpathSync(root)
}

describe('ensureSharedNativeBuild', () => {
  it('reuses a usable published entry without compiling', () => {
    const packageDir = makePackage()
    const entryDir = path.join(packageDir, 'build', 'orca-napi-linux-x64')
    mkdirSync(entryDir, { recursive: true })
    const checked = []
    const result = ensureSharedNativeBuild({
      moduleName: 'node-pty',
      packageDir,
      platform: 'linux',
      arch: 'x64',
      checkBuildDir: (dir) => {
        checked.push(dir)
        return null
      },
      // No source in packageDir: any compile attempt would throw.
      log: () => {}
    })
    expect(result).toEqual({ entryDir, built: false })
    expect(checked).toEqual([entryDir])
  })

  it('publishes beside the physical package dir, not through the project link', () => {
    const packageDir = makePackage()
    const entryDir = path.join(packageDir, 'build', 'orca-napi-linux-x64')
    mkdirSync(entryDir, { recursive: true })
    const link = path.join(makePackage(), 'node-pty')
    symlinkSync(packageDir, link, 'junction')
    const result = ensureSharedNativeBuild({
      moduleName: 'node-pty',
      packageDir: link,
      platform: 'linux',
      arch: 'x64',
      checkBuildDir: () => null,
      log: () => {}
    })
    expect(result.entryDir).toBe(entryDir)
  })

  it('refuses to compile for another platform', () => {
    const otherPlatform = process.platform === 'linux' ? 'darwin' : 'linux'
    expect(() =>
      ensureSharedNativeBuild({
        moduleName: 'node-pty',
        packageDir: makePackage(),
        platform: otherPlatform,
        arch: 'x64',
        checkBuildDir: () => null,
        log: () => {}
      })
    ).toThrow(`cannot build node-pty for ${otherPlatform}`)
  })
})

describe('checkNativeBuildDirArtifacts', () => {
  it('requires spawn-helper on macOS only', () => {
    const dir = makePackage()
    writeFileSync(path.join(dir, 'pty.node'), '')
    expect(checkNativeBuildDirArtifacts('node-pty', dir, { platform: 'linux', arch: 'x64' })).toBe(
      null
    )
    expect(
      checkNativeBuildDirArtifacts('node-pty', dir, { platform: 'darwin', arch: 'x64' })
    ).toMatch(/spawn-helper is missing/)
  })

  it('rejects a Windows addon built for another arch', () => {
    const dir = makePackage()
    mkdirSync(path.join(dir, 'conpty'))
    for (const file of ['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
      writeFileSync(path.join(dir, file), 'not-a-pe')
    }
    writeFileSync(path.join(dir, 'conpty.node'), peImage({ arch: 'x64' }))
    expect(
      checkNativeBuildDirArtifacts('node-pty', dir, { platform: 'win32', arch: 'arm64' })
    ).toMatch(/not arm64/)

    writeFileSync(path.join(dir, 'conpty.node'), peImage({ arch: 'arm64' }))
    expect(
      checkNativeBuildDirArtifacts('node-pty', dir, { platform: 'win32', arch: 'arm64' })
    ).toBe(null)

    writeFileSync(path.join(dir, 'conpty.node'), 'not-a-pe')
    expect(
      checkNativeBuildDirArtifacts('node-pty', dir, { platform: 'win32', arch: 'arm64' })
    ).toMatch(/not arm64/)
  })
})
