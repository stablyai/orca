import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tmpdir: () => 'C:\\Users\\me\\AppData\\Local\\Temp'
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  lstatSync: vi.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false })),
  statSync: vi.fn(() => {
    throw new Error('missing')
  }),
  writeFileSync: vi.fn()
}))

import { writeCliScreenshotTempFile } from './cli-screenshot-temp-file'

describe('writeCliScreenshotTempFile from a legacy WSL shell', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalDistro = process.env.ORCA_CLI_WSL_DISTRO
  const originalGetuid = process.getuid

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    process.getuid = originalGetuid
    if (originalDistro === undefined) {
      delete process.env.ORCA_CLI_WSL_DISTRO
    } else {
      process.env.ORCA_CLI_WSL_DISTRO = originalDistro
    }
  })

  it('prints the distro path of the Windows temp file', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    // Windows Node has no getuid.
    process.getuid = undefined
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    const saved = writeCliScreenshotTempFile(
      { envVar: 'ORCA_TEST_UNSET_SCREENSHOT_TMPDIR', dirName: 'orca-browser-screenshots' },
      'req_1',
      'aGk=',
      'png'
    )

    expect(saved.path).toBe(
      '/mnt/c/Users/me/AppData/Local/Temp/orca-browser-screenshots/req_1-screenshot.png'
    )
  })
})
