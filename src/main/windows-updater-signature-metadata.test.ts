import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hashWindowsUpdaterInstaller,
  readWindowsUpdaterExpectedSha512,
  readWindowsUpdaterInstallerPath
} from './windows-updater-signature-verification'

describe('windows updater installer metadata verification', () => {
  it('reads the runtime installer path only when it is a non-empty string', () => {
    expect(readWindowsUpdaterInstallerPath({ installerPath: 'C:\\cache\\orca.exe' } as never)).toBe(
      'C:\\cache\\orca.exe'
    )
    expect(readWindowsUpdaterInstallerPath({ installerPath: '' } as never)).toBeNull()
    expect(readWindowsUpdaterInstallerPath({ installerPath: 42 } as never)).toBeNull()
    expect(readWindowsUpdaterInstallerPath({} as never)).toBeNull()
  })

  it('reads the Windows installer SHA512 from update metadata', () => {
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        files: [
          { url: 'orca-1.2.3.exe.blockmap', sha512: 'blockmap-sha' },
          { url: 'orca-1.2.3.exe', sha512: 'installer-sha' }
        ],
        path: '',
        sha512: '',
        releaseDate: ''
      })
    ).toBe('installer-sha')
  })

  it('fails closed instead of guessing when multiple Windows installers are present', () => {
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        files: [
          { url: 'orca-1.2.3-x64.exe', sha512: 'x64-sha' },
          { url: 'orca-1.2.3-arm64.exe', sha512: 'arm64-sha' }
        ],
        path: '',
        sha512: 'legacy-sha',
        releaseDate: ''
      })
    ).toBeNull()
  })

  it('uses the selected Windows installer path when multiple installers are present', () => {
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        files: [
          { url: 'orca-1.2.3-x64.exe', sha512: 'x64-sha' },
          { url: 'orca-1.2.3-arm64.exe', sha512: 'arm64-sha' }
        ],
        path: 'orca-1.2.3-arm64.exe',
        sha512: 'legacy-sha',
        releaseDate: ''
      })
    ).toBe('arm64-sha')
  })

  it('reads the legacy Windows installer SHA512 only when no file list is present', () => {
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        path: 'orca-1.2.3.exe',
        sha512: 'legacy-sha',
        releaseDate: ''
      } as never)
    ).toBe('legacy-sha')
  })

  it('fails closed when Windows installer SHA512 metadata is absent', () => {
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        files: [{ url: 'orca-1.2.3.exe' } as never],
        path: '',
        sha512: '',
        releaseDate: ''
      })
    ).toBeNull()
    expect(
      readWindowsUpdaterExpectedSha512({
        version: '1.2.3',
        files: [{ url: 'orca-1.2.3.zip', sha512: 'zip-sha' }],
        path: '',
        sha512: '',
        releaseDate: ''
      })
    ).toBeNull()
  })

  it('hashes installers using base64 SHA512 metadata format', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orca-updater-signature-'))
    const installerPath = join(tempDir, 'orca.exe')
    try {
      await writeFile(installerPath, 'signed payload')

      await expect(hashWindowsUpdaterInstaller(installerPath)).resolves.toBe(
        '0GBGuVNwbSPpWXqibRQW02+wxo0j3M0YVxZYFkrsGUUS9d62uWRHh9m5RxyBA27WhrQ+spnduHemws3wpSiS+g=='
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
