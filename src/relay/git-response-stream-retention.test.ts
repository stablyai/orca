import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { GitResponseStreamRegistry } from './git-response-stream'

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

class DigestingGitDispatcher extends RelayDispatcher {
  readonly digest = createHash('sha256')
  chunksSeen = 0
  ended = false

  constructor(private readonly registry: GitResponseStreamRegistry) {
    super(() => true)
  }

  override async notifyBulk(method: string, params?: Record<string, unknown>): Promise<void> {
    if (method === 'git.responseEnd') {
      this.ended = true
      return
    }
    if (
      method !== 'git.responseChunk' ||
      typeof params?.streamId !== 'number' ||
      typeof params.seq !== 'number' ||
      typeof params.data !== 'string'
    ) {
      throw new Error('Expected a complete Git response chunk')
    }
    this.digest.update(Buffer.from(params.data, 'base64'))
    this.chunksSeen++
    if (params.seq < 54) {
      this.registry.recordAck(params.streamId, params.seq, 1)
    }
  }
}

function startLargeReply(registry: GitResponseStreamRegistry, dispatcher: RelayDispatcher) {
  const result = { stdout: Buffer.alloc(9 * 1024 * 1024, 120).toString('utf8'), stderr: '' }
  const payload = Buffer.from(JSON.stringify(result), 'utf8')
  return {
    marker: registry.startStream(payload, dispatcher, { clientId: 1, isStale: () => false }),
    digest: createHash('sha256').update(payload).digest('hex')
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Git response consumed chunk ownership', () => {
  it('releases sent copies while an acknowledged large reply waits for its remaining credits', async () => {
    const registry = new GitResponseStreamRegistry()
    const dispatcher = new DigestingGitDispatcher(registry)
    try {
      await collect()
      const baseline = process.memoryUsage().heapUsed
      const { marker, digest } = startLargeReply(registry, dispatcher)
      await collect()

      expect(dispatcher.chunksSeen).toBe(58)
      expect(dispatcher.ended).toBe(false)
      expect(process.memoryUsage().heapUsed - baseline).toBeLessThan(6 * 1024 * 1024)

      registry.recordAck(marker.__orcaGitResponseStream.streamId, Number.MAX_SAFE_INTEGER, 1)
      await collect()
      expect(dispatcher.chunksSeen).toBe(marker.__orcaGitResponseStream.chunkCount)
      expect(dispatcher.ended).toBe(true)
      expect(dispatcher.digest.digest('hex')).toBe(digest)
    } finally {
      registry.disposeAll()
      await new Promise<void>((resolve) => setImmediate(resolve))
      dispatcher.dispose()
    }
  })

  it('preserves queued chunk values and the admission snapshot through a blocked sink', async () => {
    const registry = new GitResponseStreamRegistry()
    const dispatcher = new RelayDispatcher(() => true)
    let releaseWrite: () => void = () => {}
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const notifyBulk = vi
      .spyOn(dispatcher, 'notifyBulk')
      .mockImplementationOnce(() => blockedWrite)
      .mockResolvedValue(undefined)
    vi.spyOn(dispatcher, 'producerDataBudget').mockReturnValue(8)
    try {
      const payload = Buffer.from('A😀Bé\0end', 'utf8')
      const expected = Buffer.from(payload)
      const marker = registry.startStream(payload, dispatcher, {
        clientId: 1,
        isStale: () => false
      })
      payload.fill(120)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(notifyBulk).toHaveBeenCalledOnce()
      registry.recordAck(marker.__orcaGitResponseStream.streamId, Number.MAX_SAFE_INTEGER, 1)
      releaseWrite()
      await new Promise<void>((resolve) => setImmediate(resolve))
      const parts = notifyBulk.mock.calls.flatMap(([method, params]) =>
        method === 'git.responseChunk' && typeof params?.data === 'string'
          ? [Buffer.from(params.data, 'base64')]
          : []
      )
      expect(Buffer.concat(parts)).toEqual(expected)
      expect(notifyBulk.mock.calls.map(([method]) => method)).toEqual([
        'git.responseChunk',
        'git.responseChunk',
        'git.responseEnd'
      ])
    } finally {
      releaseWrite()
      registry.disposeAll()
      await new Promise<void>((resolve) => setImmediate(resolve))
      dispatcher.dispose()
    }
  })
})
