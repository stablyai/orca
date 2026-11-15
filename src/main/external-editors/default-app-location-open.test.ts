import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applicationInfo, openPath, runProcess } = vi.hoisted(() => ({
  applicationInfo: vi.fn(),
  openPath: vi.fn(),
  runProcess: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getApplicationInfoForProtocol: applicationInfo },
  shell: { openPath }
}))
vi.mock('@orca/process-host', () => ({ runProcess }))

import { openPathInDefaultApp } from './default-app-location-open'
import type { RuntimeFileOpenPosition } from '../../shared/file-access/runtime-editor-file-open'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const filePath = '/tmp/project with spaces/main #1.json'

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('openPathInDefaultApp', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setPlatform('darwin')
    applicationInfo.mockResolvedValue({ path: '/Applications/Cursor.app' })
    runProcess.mockResolvedValue({ code: 0, timedOut: false })
    openPath.mockResolvedValue('')
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it.each([
    ['Cursor.app', { line: 551, column: 7 }, '551:7'],
    ['Visual Studio Code.app', { line: 551 }, '551'],
    ['Visual Studio Code - Insiders.app', { line: 551, column: 7 }, '551:7']
  ])(
    'hands the line to a default %s instead of the OS opener',
    async (bundle, location, suffix) => {
      const appPath = `/Users/ada/Applications/${bundle}`
      applicationInfo.mockResolvedValue({ path: appPath })

      await expect(openPathInDefaultApp(filePath, location)).resolves.toBe('')

      expect(applicationInfo).toHaveBeenCalledWith(
        'file:///tmp/project%20with%20spaces/main%20%231.json'
      )
      expect(runProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          program: '/usr/bin/open',
          args: ['-n', '-g', '-a', appPath, '--args', '--goto', `${filePath}:${suffix}`],
          env: {},
          timeoutMs: null
        })
      )
      expect(openPath).not.toHaveBeenCalled()
    }
  )

  it.each<[string, () => void]>([
    ['another default app', () => applicationInfo.mockResolvedValue({ path: '/A/Zed.app' })],
    ['a failed association lookup', () => applicationInfo.mockRejectedValue(new Error('none'))],
    ['an open that exits non-zero', () => runProcess.mockResolvedValue({ code: 1 })],
    ['an open that cannot spawn', () => runProcess.mockRejectedValue(new Error('ENOENT'))]
  ])('opens once with the OS opener on %s', async (_name, arrange) => {
    arrange()
    openPath.mockResolvedValue('no app')

    await expect(openPathInDefaultApp(filePath, { line: 551 })).resolves.toBe('no app')
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenCalledWith(filePath)
  })

  it.each<[string, NodeJS.Platform, RuntimeFileOpenPosition | undefined]>([
    ['links without a line', 'darwin', undefined],
    ['a zero line', 'darwin', { line: 0 }],
    ['a fractional line', 'darwin', { line: 1.5 }],
    ['a zero column', 'darwin', { line: 551, column: 0 }],
    ['Linux', 'linux', { line: 551 }],
    ['Windows', 'win32', { line: 551 }]
  ])('leaves %s to the OS opener', async (_name, platform, location) => {
    setPlatform(platform)

    await expect(openPathInDefaultApp(filePath, location)).resolves.toBe('')
    expect(applicationInfo).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
    expect(openPath).toHaveBeenCalledWith(filePath)
  })
})
