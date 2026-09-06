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

function createFakeMux(marker: { streamId: number; totalBytes: number; chunkCount: number }) {
  const chunkHandlers: ((p: Record<string, unknown>) => void)[] = []
  const notify = vi.fn()
  return {
    notify,
    chunkHandlers,
    mux: {
      request: async () => ({ __orcaGitResponseStream: marker }),
      onNotificationByMethod: (method: string, handler: (p: Record<string, unknown>) => void) => {
        if (method === 'git.responseChunk') {
          chunkHandlers.push(handler)
        }
        return () => {}
      },
      onDispose: () => () => {},
      isDisposed: () => false,
      notify
    } as unknown as SshChannelMultiplexer
  }
}

// Why: without the marker gate the host Buffer.concats and JSON.parses whatever the relay declares,
// so an oversized or hostile response is reassembled in full before anything can reject it.
describe('requestGitStreamable reassembly cap', () => {
  it('rejects an over-cap stream at the marker and cancels it before any chunk transfers', async () => {
    const { mux, notify } = createFakeMux({
      streamId: 7,
      totalBytes: 64 * 1024 * 1024,
      chunkCount: 1
    })

    await expect(requestGitStreamable(mux, 'git.diff', { cwd: '/repo' })).rejects.toThrow(
      /above the \d+ byte cap/
    )
    // Tell the relay to stop sending rather than draining a payload we rejected.
    expect(notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 7 })
    // No chunk was acked, i.e. none was accepted.
    expect(notify).not.toHaveBeenCalledWith('git.responseAck', expect.anything())
  })

  it('admits a stream declared exactly at the cap', async () => {
    const payload = Buffer.from(JSON.stringify({ kind: 'text' }), 'utf-8')
    const { mux, notify } = createFakeMux({
      streamId: 8,
      totalBytes: payload.length,
      chunkCount: 1
    })

    const settled = vi.fn()
    void requestGitStreamable(mux, 'git.diff', { cwd: '/repo' }, { maxBytes: payload.length }).then(
      settled,
      settled
    )
    await Promise.resolve()
    await Promise.resolve()

    // The marker passed the gate: the stream was not cancelled and nothing rejected.
    expect(notify).not.toHaveBeenCalledWith('git.cancelResponseStream', expect.anything())
    expect(settled).not.toHaveBeenCalled()
  })

  // Why: the marker gate only bounds the declared size; a relay that declares small and
  // then streams forever (never sending responseEnd) must be cut off mid-flight.
  it('rejects a relay that streams past its declared size', async () => {
    const chunk = Buffer.from('a'.repeat(8), 'utf-8')
    const { mux, chunkHandlers, notify } = createFakeMux({
      streamId: 9,
      totalBytes: chunk.length,
      chunkCount: 1
    })

    const result = requestGitStreamable(mux, 'git.diff', { cwd: '/repo' })
    await Promise.resolve()
    await Promise.resolve()

    const feed = chunkHandlers[0]
    feed({ streamId: 9, seq: 0, data: chunk.toString('base64') })
    feed({ streamId: 9, seq: 1, data: chunk.toString('base64') })

    await expect(result).rejects.toThrow(/sent more chunks than declared/)
    expect(notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 9 })
  })

  it('rejects a chunk that overruns the declared byte total', async () => {
    const { mux, chunkHandlers, notify } = createFakeMux({
      streamId: 10,
      totalBytes: 4,
      chunkCount: 2
    })

    const result = requestGitStreamable(mux, 'git.diff', { cwd: '/repo' })
    await Promise.resolve()
    await Promise.resolve()

    chunkHandlers[0]({
      streamId: 10,
      seq: 0,
      data: Buffer.from('abcdefgh', 'utf-8').toString('base64')
    })

    await expect(result).rejects.toThrow(/overran declared size: 8\/4 bytes/)
    expect(notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 10 })
  })
})
