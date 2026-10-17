import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, sendMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), sendMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcRenderer: { invoke: invokeMock, send: sendMock },
  webFrame: {}
}))

import { uiClipboardAndWindowControlsApi } from './ui-bridge-clipboard-and-window-controls'

describe('native selection action preload bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    sendMock.mockReset()
  })

  it.each(['copy', 'select-all'] as const)(
    'returns the dispatch acknowledgement for %s',
    async (action) => {
      invokeMock.mockResolvedValue(true)

      await expect(
        uiClipboardAndWindowControlsApi.performNativeSelectionAction(action)
      ).resolves.toBe(true)
      expect(invokeMock).toHaveBeenCalledWith('ui:performNativeSelectionAction', action)
      expect(sendMock).not.toHaveBeenCalled()
    }
  )

  it.each([false, undefined])(
    'returns false when dispatch is not acknowledged (%s)',
    async (result) => {
      invokeMock.mockResolvedValue(result)

      await expect(
        uiClipboardAndWindowControlsApi.performNativeSelectionAction('copy')
      ).resolves.toBe(false)
    }
  )

  it('returns false when IPC rejects so callers may safely ignore the promise', async () => {
    invokeMock.mockRejectedValue(new Error('No handler registered'))

    await expect(
      uiClipboardAndWindowControlsApi.performNativeSelectionAction('copy')
    ).resolves.toBe(false)
  })
})
