import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as CompatibilityModule from './macos-computer-use-helper-compatibility'

const compatibilityOverride = vi.hoisted(() => ({ disabled: false }))

vi.mock('./macos-computer-use-helper-compatibility', async (importOriginal) => {
  const actual = await importOriginal<typeof CompatibilityModule>()
  return {
    ...actual,
    getMacOSComputerUseHelperCompatibility: (helperAppPath: string) =>
      compatibilityOverride.disabled
        ? { compatible: true, currentVersion: '0', minimumVersion: '0' }
        : actual.getMacOSComputerUseHelperCompatibility(helperAppPath)
  }
})

const runRepro =
  process.platform === 'darwin' && process.env.ORCA_COMPUTER_HELPER_LAUNCHSERVICES_REPRO === '1'

describe.skipIf(!runRepro)('macOS Computer Use LaunchServices compatibility repro', () => {
  let directory = ''
  let helperAppPath = ''
  let originalOverride: string | undefined

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-computer-helper-launchservices-'))
    helperAppPath = join(directory, 'Orca Computer Use Incompatible.app')
    const sourceAppPath = join(
      process.cwd(),
      'native',
      'computer-use-macos',
      '.build',
      'release',
      'Orca Computer Use.app'
    )
    if (!existsSync(sourceAppPath)) {
      throw new Error(`Missing staged helper at ${sourceAppPath}; run pnpm build:computer-macos`)
    }
    execFileSync('/usr/bin/ditto', [sourceAppPath, helperAppPath])
    raiseHelperMinimumAboveCurrentOS(helperAppPath, directory)
    originalOverride = process.env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH
    process.env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH = helperAppPath
  }, 30_000)

  afterAll(() => {
    if (originalOverride === undefined) {
      delete process.env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH
    } else {
      process.env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH = originalOverride
    }
    rmSync(directory, { recursive: true, force: true })
  })

  it('gets exact -10825 from real open and no helper status file', () => {
    const statusPath = join(directory, 'raw-status.json')
    const result = spawnSync(
      '/usr/bin/open',
      ['-n', helperAppPath, '--args', '--permission-status-file', statusPath],
      { encoding: 'utf8' }
    )

    expect(result.status).not.toBe(0)
    expect(`${result.stderr}${result.stdout}`).toContain('-10825')
    expect(existsSync(statusPath)).toBe(false)
  })

  it('returns structured unavailability before launching the incompatible helper', async () => {
    compatibilityOverride.disabled = false
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      platform: 'darwin',
      helperAppPath,
      helperUnavailableReason: expect.stringContaining('requires macOS')
    })
  })

  it('reproduces the raw -10825 when the compatibility fix is disabled', async () => {
    compatibilityOverride.disabled = true
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')

    await expect(getComputerUsePermissionStatus()).rejects.toMatchObject({
      name: 'RuntimeClientError',
      code: 'accessibility_error',
      message: expect.stringContaining('-10825')
    })
  })
})

function raiseHelperMinimumAboveCurrentOS(helperAppPath: string, directory: string): void {
  const currentVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8'
  }).trim()
  const futureVersion = `${Number.parseInt(currentVersion.split('.')[0] ?? '', 10) + 1}.0`
  const executablePath = join(helperAppPath, 'Contents', 'MacOS', 'orca-computer-use-macos')
  const mutatedSlices: string[] = []
  for (const architecture of ['arm64', 'x86_64']) {
    const thinPath = join(directory, `helper-${architecture}`)
    const mutatedPath = join(directory, `helper-${architecture}-future`)
    execFileSync('/usr/bin/lipo', [executablePath, '-thin', architecture, '-output', thinPath])
    execFileSync('/usr/bin/xcrun', [
      'vtool',
      '-set-build-version',
      'macos',
      futureVersion,
      futureVersion,
      '-replace',
      '-output',
      mutatedPath,
      thinPath
    ])
    mutatedSlices.push(mutatedPath)
  }
  execFileSync('/usr/bin/lipo', ['-create', ...mutatedSlices, '-output', executablePath])
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'LSMinimumSystemVersion',
    '-string',
    futureVersion,
    join(helperAppPath, 'Contents', 'Info.plist')
  ])
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    'com.stablyai.orca.computer-use.launchservices-repro',
    join(helperAppPath, 'Contents', 'Info.plist')
  ])
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', helperAppPath])
}
