import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPtyRedrawFromRuntimeController } from './pty-redraw'

const { getProviderForPty, sendSignal } = vi.hoisted(() => ({
  getProviderForPty: vi.fn(),
  sendSignal: vi.fn()
}))
vi.mock('../provider/registry', () => ({ getProviderForPty }))

describe('execution-host PTY redraw', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getProviderForPty.mockReturnValue({ sendSignal })
    sendSignal.mockResolvedValue(undefined)
  })

  it.each(['daemon-pane', 'ssh:connection-1:pty-1'])(
    'routes %s through its provider',
    async (id) => {
      expect(await requestPtyRedrawFromRuntimeController(id)).toBe(true)
      expect(getProviderForPty).toHaveBeenCalledExactlyOnceWith(id)
      expect(sendSignal).toHaveBeenCalledExactlyOnceWith(id, 'SIGWINCH')
    }
  )

  it('does not substitute a local provider when the execution host is unavailable', async () => {
    getProviderForPty.mockImplementation(() => {
      throw new Error('provider unavailable')
    })
    expect(await requestPtyRedrawFromRuntimeController('ssh:connection-1:pty-1')).toBe(false)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('treats an unsupported or failed signal as best-effort', async () => {
    sendSignal.mockRejectedValue(new Error('signal unsupported'))
    expect(await requestPtyRedrawFromRuntimeController('daemon-pane')).toBe(false)
  })
})
