import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { listenForPortForward } from './ssh2-port-forward-provider'

describe('listenForPortForward', () => {
  it('keeps an error handler once listening, so an accept failure cannot crash main', async () => {
    const server = createServer()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await listenForPortForward(server, '127.0.0.1', 0)
      expect(() => server.emit('error', new Error('accept EMFILE'))).not.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('accept EMFILE'))
    } finally {
      warn.mockRestore()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
