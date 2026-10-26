import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock, openUrlInInstalledBrowserMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  openUrlInInstalledBrowserMock: vi.fn()
}))
vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))
vi.mock('./external-browser-launch', () => ({
  openUrlInInstalledBrowser: openUrlInInstalledBrowserMock
}))

import { openExternalUrl, setExternalBrowserSettingsReader } from './open-external-url'

const URL = 'https://github.com/stablyai/orca/pull/1'
let installed: Set<string>
let settings: { externalBrowserId?: string | null }

beforeEach(() => {
  openExternalMock.mockReset().mockResolvedValue(undefined)
  openUrlInInstalledBrowserMock
    .mockReset()
    .mockImplementation(async (id: string) => installed.has(id))
  installed = new Set(['edge', 'chrome'])
  settings = { externalBrowserId: 'edge' }
  setExternalBrowserSettingsReader(() => settings)
})

describe('openExternalUrl', () => {
  it('opens in the configured default browser instead of the OS default', async () => {
    await openExternalUrl(URL)

    expect(openUrlInInstalledBrowserMock).toHaveBeenCalledWith('edge', URL)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('opens an explicit browser pick without changing the default', async () => {
    await openExternalUrl(URL, { browserId: 'chrome' })

    expect(openUrlInInstalledBrowserMock).toHaveBeenCalledWith('chrome', URL)
    expect(openUrlInInstalledBrowserMock).not.toHaveBeenCalledWith('edge', URL)
    expect(settings).toEqual({ externalBrowserId: 'edge' })
  })

  it('falls back to the OS default when the configured browser is not installed', async () => {
    installed.delete('edge')

    await openExternalUrl(URL)

    expect(openExternalMock).toHaveBeenCalledWith(URL)
  })

  it('uses the OS default when no browser is configured', async () => {
    settings = {}

    await openExternalUrl(URL)

    expect(openUrlInInstalledBrowserMock).not.toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledWith(URL)
  })

  it('falls back to the OS default when a known browser fails to launch', async () => {
    openUrlInInstalledBrowserMock.mockResolvedValue(false)

    await openExternalUrl(URL, { browserId: 'chrome' })

    expect(openExternalMock).toHaveBeenCalledWith(URL)
  })

  it('forces the OS default for the reserved system-default id', async () => {
    await openExternalUrl(URL, { browserId: 'system-default' })

    expect(openUrlInInstalledBrowserMock).not.toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledWith(URL)
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd'])(
    'rejects %s before any launch',
    async (rawUrl) => {
      await openExternalUrl(rawUrl)
      await openExternalUrl(rawUrl, { browserId: 'chrome' })

      expect(openUrlInInstalledBrowserMock).not.toHaveBeenCalled()
      expect(openExternalMock).not.toHaveBeenCalled()
    }
  )
})
