import { describe, expect, it, vi } from 'vitest'
import { dispatchPageKeyEvent } from './guest-direct-key-input'
import { createMockWebContents, mockAsWebContents } from '../transport/cdp-ws-proxy-test-harness'

vi.mock('./guest-focused-frame-route', () => ({
  resolveFocusedFrameRoute: async () => ({ kind: 'unknown' })
}))

describe('guest input route admission', () => {
  it('refuses keys when the focused guest frame cannot be resolved', async () => {
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')

    await expect(
      dispatchPageKeyEvent(
        mockAsWebContents(mock),
        { type: 'keyDown', key: 'a', text: 'a' },
        async () => ({})
      )
    ).rejects.toMatchObject({ code: 'browser_input_target_unavailable' })
  })
})
