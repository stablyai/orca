import { describe, expect, it, vi } from 'vitest'
import { requestGitStreamable } from './ssh-git-response-stream-reader'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'

function createMockTransport(): MultiplexerTransport {
  return {
    write: () => {},
    onData: () => {},
    onClose: () => {}
  }
}

describe('requestGitStreamable on an already-dead multiplexer', () => {
  it('rejects as a transient relay loss and leaves no listener on the caller signal', async () => {
    const mux = new SshChannelMultiplexer(createMockTransport())
    mux.dispose('connection_lost')
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(
      requestGitStreamable(mux, 'git.status', { cwd: '/repo' }, { signal: controller.signal })
    ).rejects.toThrow('SSH connection lost, reconnecting...')

    // #11953: a disposed mux fails synchronously inside onDispose, so the abort
    // listener must already be registered when that cleanup runs — otherwise it
    // outlives the request for the lifetime of the caller's signal.
    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length)
  })
})
