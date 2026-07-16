import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, renderNativePowerPointPreviewMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  renderNativePowerPointPreviewMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../office/native-powerpoint-preview', () => ({
  renderNativePowerPointPreview: renderNativePowerPointPreviewMock
}))

import { registerPowerPointPreviewHandlers } from './powerpoint-preview'

describe('registerPowerPointPreviewHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    renderNativePowerPointPreviewMock.mockReset()
  })

  it('cancels an in-flight export only for the renderer that started it', async () => {
    let exportSignal: AbortSignal | undefined
    renderNativePowerPointPreviewMock.mockImplementation(
      (_request: unknown, _dependencies: undefined, signal: AbortSignal) =>
        new Promise((resolve) => {
          exportSignal = signal
          signal.addEventListener(
            'abort',
            () => resolve({ status: 'unavailable', reason: 'cancelled' }),
            { once: true }
          )
        })
    )
    registerPowerPointPreviewHandlers()
    const render = handlers.get('powerpointPreview:render')!
    const cancel = handlers.get('powerpointPreview:cancel')!
    const ownerEvent = { sender: { id: 7 } }
    const otherEvent = { sender: { id: 8 } }

    const pending = render(ownerEvent, {
      contentBase64: 'cHB0eA==',
      requestToken: 'preview-1'
    }) as Promise<unknown>
    cancel(otherEvent, { requestToken: 'preview-1' })
    expect(exportSignal?.aborted).toBe(false)

    cancel(ownerEvent, { requestToken: 'preview-1' })
    expect(exportSignal?.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'cancelled' })
  })
})
