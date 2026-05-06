import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, showOpenDialogMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
    openPath: vi.fn()
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  }
}))

import { registerShellHandlers } from './shell'

describe('registerShellHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    showOpenDialogMock.mockReset()
  })

  function getHandler(channel: string): (event: unknown, args?: unknown) => Promise<unknown> {
    registerShellHandlers()
    const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler not registered`)
    }
    return call[1] as (event: unknown, args?: unknown) => Promise<unknown>
  }

  it('picks audio files with a constrained native dialog filter', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/kaylee/Downloads/Note_block_pling.ogg']
    })

    const handler = getHandler('shell:pickAudio')
    await expect(handler({})).resolves.toBe('/Users/kaylee/Downloads/Note_block_pling.ogg')
    expect(showOpenDialogMock).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
  })

  it('returns null when audio picking is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: true,
      filePaths: []
    })

    const handler = getHandler('shell:pickAudio')
    await expect(handler({})).resolves.toBeNull()
  })
})
