import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { GitResponseStreamRegistry } from './git-response-stream'
import { GIT_RESPONSE_CHUNK_SIZE, STREAM_ACK_WINDOW_CHUNKS } from './protocol'

async function flushPump(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('GitResponseStreamRegistry client ownership', () => {
  const registries: GitResponseStreamRegistry[] = []

  afterEach(() => {
    for (const registry of registries) {
      registry.disposeAll()
    }
    registries.length = 0
  })

  it('ignores acknowledgements and cancellation from a different relay client', async () => {
    const ownerClientId = 7
    const notifyBulk = vi.fn().mockResolvedValue(undefined)
    const dispatcher = {
      notifyBulk,
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const context: RequestContext = {
      clientId: ownerClientId,
      isStale: () => false
    }
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)
    const payload = Buffer.alloc(GIT_RESPONSE_CHUNK_SIZE * (STREAM_ACK_WINDOW_CHUNKS * 3))
    const marker = registry.startStream(payload, dispatcher, context)
    const streamId = marker.__orcaGitResponseStream.streamId

    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    registry.recordAck(streamId, 10_000, ownerClientId + 1)
    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    registry.abort(streamId, ownerClientId + 1)
    registry.recordAck(streamId, STREAM_ACK_WINDOW_CHUNKS - 1, ownerClientId)
    await flushPump()
    expect(notifyBulk.mock.calls.length).toBeGreaterThan(STREAM_ACK_WINDOW_CHUNKS)
  })

  it('contains a secondary failure while reporting a stream error', async () => {
    const notifyBulk = vi.fn().mockRejectedValue(new Error('socket closed'))
    const dispatcher = { notifyBulk, notify: vi.fn() } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)

    registry.startStream(Buffer.from('payload'), dispatcher, {
      clientId: 7,
      isStale: () => false
    })

    await flushPump()
    await flushPump()

    expect(notifyBulk).toHaveBeenCalledTimes(2)
    expect(notifyBulk.mock.calls[0]?.[0]).toBe('git.responseChunk')
    expect(notifyBulk.mock.calls[1]?.[0]).toBe('git.responseError')
  })

  it('uses encoded producer capacity without collapsing chunks during saturation', async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const notifyBulk = vi
      .fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined)
    const producerDataBudget = vi.fn(() => 8)
    const dispatcher = {
      notifyBulk,
      producerDataBudget
    } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)
    const ownerClientId = 7

    const marker = registry.startStream(Buffer.alloc(12), dispatcher, {
      clientId: ownerClientId,
      isStale: () => false
    })
    const streamId = marker.__orcaGitResponseStream.streamId
    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(1)

    registry.recordAck(streamId, 1_000, ownerClientId)
    releaseFirst()
    await flushPump()
    await flushPump()

    expect(producerDataBudget).toHaveBeenCalledExactlyOnceWith(
      'git.responseChunk',
      { streamId, seq: 12 },
      ownerClientId
    )
    expect(marker.__orcaGitResponseStream.chunkCount).toBe(2)
    expect(notifyBulk).toHaveBeenCalledTimes(3)
    const chunks = notifyBulk.mock.calls
      .filter(([method]) => method === 'git.responseChunk')
      .map(([, params]) => params as { data: string })
    expect(chunks).toHaveLength(2)
    expect(chunks.every(({ data }) => data.length <= 8)).toBe(true)
    expect(chunks.map(({ data }) => Buffer.from(data, 'base64').length)).toEqual([6, 6])
  })
})
