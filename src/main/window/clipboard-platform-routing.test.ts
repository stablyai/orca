import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  readText: vi.fn(),
  clear: vi.fn(),
  getSwitchValue: vi.fn(() => 'wayland'),
  getPath: vi.fn(),
  runProcess: vi.fn(),
  stage: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    commandLine: { getSwitchValue: mocks.getSwitchValue },
    getPath: mocks.getPath
  },
  clipboard: { writeText: mocks.writeText, readText: mocks.readText, clear: mocks.clear }
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./clipboard-publisher-executable', () => ({ stageClipboardPublisher: mocks.stage }))

import { publishClipboardText } from './clipboard-text-publisher'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('WAYLAND_DISPLAY', 'wayland-1')
  vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
  vi.stubEnv('APPIMAGE', '/tmp/Orca.AppImage')
  vi.stubEnv('APPDIR', '/tmp/.mount_Orca')
  let contents = ''
  mocks.writeText.mockImplementation((text: string) => {
    contents = text
  })
  mocks.readText.mockImplementation(() => contents)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe.each(['darwin', 'win32'] as const)('%s clipboard compatibility', (platform) => {
  it('uses the existing Electron writers without Linux helpers or cache clearing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const text = 'café 雪\r\nsecond line'

    await publishClipboardText(text, 'ordinary')
    expect(mocks.writeText).toHaveBeenCalledWith(text)
    expect(mocks.readText).not.toHaveBeenCalled()

    await publishClipboardText(text, 'terminal')
    expect(mocks.writeText).toHaveBeenCalledTimes(2)
    expect(mocks.readText).toHaveBeenCalledTimes(1)
    expect(mocks.getSwitchValue).not.toHaveBeenCalled()
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.runProcess).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('preserves terminal write verification under clipboard contention', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    mocks.readText.mockReturnValue('old clipboard')

    await expect(publishClipboardText('new clipboard', 'terminal')).rejects.toThrow(
      'Clipboard write verification failed'
    )
    await expect(publishClipboardText('ordinary clipboard', 'ordinary')).resolves.toBeUndefined()
    expect(mocks.readText).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('does not apply the native helper queue limit to concurrent Electron writes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => publishClipboardText(String(index), 'ordinary'))
    )
    expect(mocks.writeText).toHaveBeenCalledTimes(40)
    expect(mocks.runProcess).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })
})
