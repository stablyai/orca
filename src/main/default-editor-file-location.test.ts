import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'

const { applicationInfo, exists, launch } = vi.hoisted(() => ({
  applicationInfo: vi.fn(),
  exists: vi.fn(),
  launch: vi.fn()
}))
vi.mock('electron', () => ({ app: { getApplicationInfoForProtocol: applicationInfo } }))
vi.mock('node:fs', () => ({ existsSync: exists }))
vi.mock('./external-editor-launch', () => ({ launchExternalEditor: launch }))

import { openDefaultEditorAtLocation } from './default-editor-file-location'

describe('openDefaultEditorAtLocation', () => {
  const filePath = '/tmp/project with spaces/日本語 #1.ts'
  beforeEach(() => {
    vi.resetAllMocks()
    applicationInfo.mockResolvedValue({ path: '/Applications/Cursor.app' })
    exists.mockReturnValue(true)
    launch.mockResolvedValue(undefined)
  })

  it.each([
    ['Cursor.app', 'cursor'],
    ['Visual Studio Code.app', 'code'],
    ['Visual Studio Code - Insiders.app', 'code']
  ])('opens the associated %s at the exact line and column', async (bundle, command) => {
    const applicationPath = `/Users/ada/Applications/${bundle}`
    applicationInfo.mockResolvedValue({ path: applicationPath })
    await expect(
      openDefaultEditorAtLocation(filePath, { line: 551, column: 7 }, 'darwin')
    ).resolves.toBe(true)
    expect(applicationInfo).toHaveBeenCalledWith(pathToFileURL(filePath).href)
    expect(launch).toHaveBeenCalledWith({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: `${applicationPath}/Contents/Resources/app/bin/${command}`,
      spawnArgs: ['--goto', `${filePath}:551:7`]
    })
  })

  it('supports links with only a line number', async () => {
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, 'darwin')).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ spawnArgs: ['--goto', `${filePath}:551`] })
    )
  })

  it('does not let location metadata replace the validated path', async () => {
    const location = { line: 551, pathText: '/tmp/another-file.ts' }
    await expect(openDefaultEditorAtLocation(filePath, location, 'darwin')).resolves.toBe(true)
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnArgs: ['--goto', `${filePath}:551`]
      })
    )
  })

  it.each(['linux', 'win32'] as const)('leaves %s launches to the OS', async (platform) => {
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, platform)).resolves.toBe(
      false
    )
    expect(applicationInfo).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { line: 0 },
    { line: -1 },
    { line: 1.5 },
    { line: Number.NaN },
    { line: Infinity },
    { line: Number.MAX_SAFE_INTEGER + 1 },
    { line: 551, column: 0 },
    { line: 551, column: 1.5 }
  ])('does not look up an app without a valid location: %j', async (location) => {
    await expect(openDefaultEditorAtLocation(filePath, location, 'darwin')).resolves.toBe(false)
    expect(applicationInfo).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('leaves unsupported default apps to the OS', async () => {
    applicationInfo.mockResolvedValue({ path: '/Applications/TextEdit.app' })
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, 'darwin')).resolves.toBe(
      false
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('falls back when the associated app has no bundled CLI', async () => {
    exists.mockReturnValue(false)
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, 'darwin')).resolves.toBe(
      false
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('falls back when association lookup fails', async () => {
    applicationInfo.mockRejectedValue(new Error('no association'))
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, 'darwin')).resolves.toBe(
      false
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('falls back when the editor launcher fails', async () => {
    launch.mockRejectedValue(new Error('missing executable'))
    await expect(openDefaultEditorAtLocation(filePath, { line: 551 }, 'darwin')).resolves.toBe(
      false
    )
  })
})
