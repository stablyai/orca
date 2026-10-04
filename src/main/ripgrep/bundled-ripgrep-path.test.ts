import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { toBundledRipgrepPlatform } from '../../shared/bundled-ripgrep'
import {
  bundledRipgrepCommand,
  bundledRipgrepContentKey,
  bundledRipgrepWslSpawnOptions,
  resetBundledRipgrepPathCacheForTests,
  resolveBundledRipgrepPath
} from './bundled-ripgrep-path'

const originalResourcesPath = process.resourcesPath

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value })
}

describe('bundled ripgrep path', () => {
  afterEach(() => {
    setResourcesPath(originalResourcesPath)
    resetBundledRipgrepPathCacheForTests()
  })

  it('resolves the checkout binary for this host in development', () => {
    setResourcesPath(undefined)
    const command = bundledRipgrepCommand()

    expect(command).toContain(join('@vscode', 'ripgrep-universal', 'bin'))
    expect(existsSync(command)).toBe(true)
  })

  it('resolves the Linux build for WSL-routed spawns', () => {
    setResourcesPath(undefined)
    const linuxPlatform = toBundledRipgrepPlatform('linux', process.arch)

    expect(bundledRipgrepCommand({ wsl: true })).toContain(join('bin', `${linuxPlatform}`, 'rg'))
  })

  it('prefers the packaged resources copy', () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'orca-rg-resources-'))
    try {
      const packaged = join(resourcesDir, 'ripgrep', 'linux-x64', 'rg')
      mkdirSync(join(resourcesDir, 'ripgrep', 'linux-x64'), { recursive: true })
      writeFileSync(packaged, '')
      chmodSync(packaged, 0o755)
      setResourcesPath(resourcesDir)

      expect(resolveBundledRipgrepPath('linux-x64')).toBe(realpathSync(packaged))
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true })
    }
  })

  it('names no bundled build for platforms outside the relay set', () => {
    expect(toBundledRipgrepPlatform('freebsd', 'x64')).toBeNull()
    expect(toBundledRipgrepPlatform('win32', 'ia32')).toBeNull()
  })

  it('keys the remote cache on the shipped bytes', () => {
    setResourcesPath(undefined)
    const platform = toBundledRipgrepPlatform(process.platform, process.arch)!
    const key = bundledRipgrepContentKey(platform)

    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(bundledRipgrepContentKey('win32-x64')).not.toBe(key)
  })

  it('picks the distro-arch Linux build and fails closed when its drive is unavailable', () => {
    const { wslShellCommand } = bundledRipgrepWslSpawnOptions(
      'C:\\Program Files\\Orca\\resources\\ripgrep\\linux-x64\\rg'
    )

    expect(wslShellCommand).toContain(`wslpath -u 'C:\\Program Files\\Orca\\resources\\ripgrep'`)
    expect(wslShellCommand).toContain('aarch64|arm64) a=linux-arm64')
    expect(wslShellCommand).toContain('printf %s "$d/$a/rg"')
    expect(wslShellCommand).toContain('else printf /dev/null/orca-ripgrep-unavailable')
    expect(wslShellCommand).not.toContain('else printf rg')
    expect(bundledRipgrepWslSpawnOptions('rg')).toEqual({})
  })

  it.skipIf(process.platform === 'win32')(
    'never executes a PATH ripgrep when WSL cannot translate the install drive',
    async () => {
      const { wslShellCommand } = bundledRipgrepWslSpawnOptions(
        'C:\\Orca\\resources\\ripgrep\\linux-x64\\rg'
      )
      const result = await runProcess({
        program: '/bin/bash',
        args: [
          '-c',
          `wslpath() { return 1; }; rg() { echo WRONG_RIPGREP; }; ${wslShellCommand} --version`
        ]
      })
      expect(result.code).toBeGreaterThan(2)
      expect(result.stdout).not.toContain('WRONG_RIPGREP')
    }
  )
})
