import { describe, expect, it, vi } from 'vitest'
import { requestGitStreamable } from './ssh-git-response-stream-reader'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeFrame, MessageType } from './relay-protocol'

function createMockTransport(): MultiplexerTransport {
  return {
    write: () => {},
    onData: () => {},
    onClose: () => {}
  }
}

function createFeedableTransport(): MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
} {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  return {
    write: () => {},
    onData: (callback) => dataCallbacks.push(callback),
    onClose: () => {},
    dataCallbacks
  }
}

function makeFrame(message: Record<string, unknown>, sequence: number): Buffer {
  return encodeFrame(MessageType.Regular, sequence, 0, Buffer.from(JSON.stringify(message)))
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

describe('requestGitStreamable stream identity', () => {
  it('installs marker metadata before adjacent chunk and end notifications', async () => {
    const transport = createFeedableTransport()
    const mux = new SshChannelMultiplexer(transport)
    const encoded = Buffer.from(JSON.stringify({ ok: true }))
    const promise = requestGitStreamable(mux, 'git.exec', { cwd: '/repo' })

    transport.dataCallbacks[0]!(
      Buffer.concat([
        makeFrame(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              __orcaGitResponseStream: {
                streamId: 7,
                totalBytes: encoded.length,
                chunkCount: 1
              }
            }
          },
          1
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseChunk',
            params: { streamId: 7, seq: 0, data: encoded.toString('base64') }
          },
          2
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseEnd',
            params: { streamId: 7 }
          },
          3
        )
      ])
    )

    await expect(promise).resolves.toEqual({ ok: true })
    mux.dispose()
  })

  it('fails explicitly when a mux does not run the marker hook', async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>()
    const mux = {
      request: vi.fn(async () => ({
        __orcaGitResponseStream: { streamId: 7, totalBytes: 0, chunkCount: 0 }
      })),
      isDisposed: () => false,
      notify: vi.fn(),
      onDispose: () => () => {},
      onNotificationByMethod: (
        method: string,
        callback: (params: Record<string, unknown>) => void
      ) => {
        listeners.set(method, callback)
        return () => listeners.delete(method)
      }
    }

    await expect(
      requestGitStreamable(mux as unknown as SshChannelMultiplexer, 'git.exec', {})
    ).rejects.toThrow('Git response stream identity was not installed')
    expect(listeners.size).toBe(0)
  })

  it('does not mix frames from a concurrent reader while awaiting its own sentinel', async () => {
    const transport = createFeedableTransport()
    const mux = new SshChannelMultiplexer(transport)
    const encodedA = Buffer.from(JSON.stringify({ from: 'a' }))
    const encodedB = Buffer.from(JSON.stringify({ from: 'b' }))
    const promiseA = requestGitStreamable(mux, 'git.exec', { cwd: '/a' })
    const promiseB = requestGitStreamable(mux, 'git.exec', { cwd: '/b' })

    transport.dataCallbacks[0]!(
      Buffer.concat([
        makeFrame(
          {
            jsonrpc: '2.0',
            id: 2,
            result: {
              __orcaGitResponseStream: {
                streamId: 20,
                totalBytes: encodedB.length,
                chunkCount: 1
              }
            }
          },
          1
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseChunk',
            params: { streamId: 20, seq: 0, data: encodedB.toString('base64') }
          },
          2
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseEnd',
            params: { streamId: 20 }
          },
          3
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              __orcaGitResponseStream: {
                streamId: 10,
                totalBytes: encodedA.length,
                chunkCount: 1
              }
            }
          },
          4
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseChunk',
            params: { streamId: 10, seq: 0, data: encodedA.toString('base64') }
          },
          5
        ),
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseEnd',
            params: { streamId: 10 }
          },
          6
        )
      ])
    )

    await expect(promiseA).resolves.toEqual({ from: 'a' })
    await expect(promiseB).resolves.toEqual({ from: 'b' })
    mux.dispose()
  })

  it('does not drop its own seq-0 chunk when foreign frames exceed the removed pending cap', async () => {
    const transport = createFeedableTransport()
    const mux = new SshChannelMultiplexer(transport)
    const encoded = Buffer.from(JSON.stringify({ from: 'a' }))
    const promise = requestGitStreamable(mux, 'git.exec', { cwd: '/a' })

    // Why: per-frame feeds stay sync so overflow can evict seq: 0 before the sentinel microtask; one concat yields at 64 decoder frames.
    const PRE_PR_PENDING_CAP = 64
    const frames = [
      makeFrame(
        {
          jsonrpc: '2.0',
          id: 1,
          result: {
            __orcaGitResponseStream: {
              streamId: 10,
              totalBytes: encoded.length,
              chunkCount: 1
            }
          }
        },
        1
      ),
      makeFrame(
        {
          jsonrpc: '2.0',
          method: 'git.responseChunk',
          params: { streamId: 10, seq: 0, data: encoded.toString('base64') }
        },
        2
      ),
      ...Array.from({ length: PRE_PR_PENDING_CAP + 1 }, (_, i) =>
        makeFrame(
          {
            jsonrpc: '2.0',
            method: 'git.responseChunk',
            params: {
              streamId: 999,
              seq: i,
              data: Buffer.from('x').toString('base64')
            }
          },
          3 + i
        )
      ),
      makeFrame(
        {
          jsonrpc: '2.0',
          method: 'git.responseEnd',
          params: { streamId: 10 }
        },
        3 + PRE_PR_PENDING_CAP + 1
      )
    ]
    for (const frame of frames) {
      transport.dataCallbacks[0]!(frame)
    }

    await expect(promise).resolves.toEqual({ from: 'a' })
    mux.dispose()
  })
})
