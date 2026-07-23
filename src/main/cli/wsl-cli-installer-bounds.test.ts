import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { WSL_CLI_INSPECTION_MAX_BYTES, WslCliInstaller, _internals } from './wsl-cli-installer'

function installedHostStatus(): CliInstallStatus {
  const launcherPath = 'C:\\Orca\\resources\\bin\\orca.exe'
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: launcherPath,
    pathDirectory: 'C:\\Orca\\resources\\bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: launcherPath,
    unsupportedReason: null,
    detail: null
  }
}

describe('WSL CLI launcher inspection bounds', () => {
  it('accepts encoded file output at the exact byte ceiling and rejects one byte more', () => {
    const prefix = _internals.WSL_BOUNDED_FILE_OUTPUT_PREFIX
    const exact = Buffer.alloc(WSL_CLI_INSPECTION_MAX_BYTES, 0x61)
    const oversized = Buffer.alloc(WSL_CLI_INSPECTION_MAX_BYTES + 1, 0x61)

    expect(
      _internals.parseBoundedWslFileOutput(`${prefix}${exact.toString('base64')}`)
    ).toHaveLength(WSL_CLI_INSPECTION_MAX_BYTES)
    expect(_internals.parseBoundedWslFileOutput(`${prefix}${oversized.toString('base64')}`)).toBe(
      'not_file'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'fails closed on a sparse oversized launcher without reading it whole',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-bounded-read-'))
      const home = join(root, 'home')
      const commandPath = join(home, '.local', 'bin', 'orca-ide')
      await mkdir(join(home, '.local', 'bin'), { recursive: true })
      await writeFile(commandPath, '# Orca managed WSL CLI launcher\n', 'utf8')
      await truncate(commandPath, 256 * 1024 * 1024)
      const runner = async (_distro: string, command: string): Promise<string> => {
        if (command.includes('printf %s "$HOME"')) {
          return home
        }
        if (command.includes('command -v powershell.exe')) {
          return 'yes'
        }
        if (command.includes('case ":$PATH:"')) {
          return 'yes'
        }
        return execFileSync('bash', ['-c', command], {
          encoding: 'utf8',
          maxBuffer: 256 * 1024
        })
      }
      const installer = new WslCliInstaller({
        platform: 'win32',
        distro: 'Ubuntu',
        hostInstaller: { getStatus: async () => installedHostStatus() },
        wslRunner: runner
      })

      try {
        await expect(installer.getStatus()).resolves.toMatchObject({ state: 'conflict' })
        await expect(stat(commandPath)).resolves.toHaveProperty('size', 256 * 1024 * 1024)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
