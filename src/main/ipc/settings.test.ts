import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handleMock, previewGhosttyImportMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  previewGhosttyImportMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('../ghostty/index', () => ({
  previewGhosttyImport: previewGhosttyImportMock
}))

import { registerSettingsHandlers } from './settings'

const store = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn()
}

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    previewGhosttyImportMock.mockClear()
  })

  it('registers settings:previewGhosttyImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewGhosttyImport')
  })

  it('settings:previewGhosttyImport returns preview result', async () => {
    const expected = { found: false, diff: {}, unsupportedKeys: [] }
    previewGhosttyImportMock.mockResolvedValue(expected)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewGhosttyImport'
    )?.[1] as (_event: unknown, args: unknown) => Promise<unknown>

    const result = await handler!(null, {})
    expect(result).toEqual(expected)
    expect(previewGhosttyImportMock).toHaveBeenCalledWith(store)
  })
})
