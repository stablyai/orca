import { afterEach, describe, expect, it, vi } from 'vitest'

const { writeFileSyncMock } = vi.hoisted(() => ({ writeFileSyncMock: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  lstatSync: vi.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0 })),
  statSync: vi.fn(() => {
    throw new Error('missing')
  }),
  writeFileSync: writeFileSyncMock
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

  it('saves into the distro /tmp and prints the Linux path', () => {
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

    expect(saved.path).toBe('/tmp/orca-browser-screenshots/req_1-screenshot.png')
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\\\\wsl\.localhost\\Ubuntu\\tmp\\orca-browser-screenshots[\\/]req_1-screenshot\.png$/
      ),
      expect.anything(),
      expect.anything()
    )
  })
})
