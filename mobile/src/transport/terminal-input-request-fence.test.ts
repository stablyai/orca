import { describe, expect, it, vi } from 'vitest'
import { assertTerminalInputRequestAllowed } from './terminal-input-request-fence'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'

describe('failed ordered prefix RPC fence', () => {
  it('fences only terminal.send for the failed terminal', () => {
    const failure = (terminal: string) =>
      terminal === 't' ? { outcome: 'unknown' as const, reason: 'lost' } : null
    expect(() =>
      assertTerminalInputRequestAllowed('terminal.send', { terminal: 't' }, failure)
    ).toThrow('Terminal input stopped')
    expect(() =>
      assertTerminalInputRequestAllowed('terminal.send', { terminal: 'other' }, failure)
    ).not.toThrow()
    expect(() =>
      assertTerminalInputRequestAllowed('terminal.subscribe', { terminal: 't' }, failure)
    ).not.toThrow()
  })
  it('rechecks direct requests after a connection wait before writing JSON', async () => {
    let failed = false
    const send = vi.fn(() => true)
    const tracker = new RpcClientRequestTracker({
      nextId: () => '1',
      deviceToken: 'd',
      getState: () => 'connected',
      waitForConnected: async () => {
        failed = true
      },
      sendEncrypted: send,
      validateRequest: (method, params) =>
        assertTerminalInputRequestAllowed(method, params, () =>
          failed ? { outcome: 'unknown', reason: 'lost' } : null
        )
    })
    await expect(
      tracker.sendRequest('terminal.send', { terminal: 't', text: '\r' })
    ).rejects.toThrow('Terminal input stopped')
    expect(send).not.toHaveBeenCalled()
    expect(tracker.size()).toBe(0)
  })
})
