import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { NDJSON_MAX_LINE_BYTES } from '../../shared/main-process-ndjson-framer'
import { readCodexRateLimitsViaRpc } from './codex-rpc-rate-limit-probe'

function makeRpcChild(
  rateLimitsReply: Record<string, unknown> = {
    result: { rateLimits: { primary: { usedPercent: 17 } } }
  },
  replyChunks: (reply: Buffer) => Iterable<Buffer> = (reply) => [reply]
) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const message: unknown = JSON.parse(line)
      if (typeof message !== 'object' || message === null || !('method' in message)) {
        return
      }
      const id = 'id' in message ? message.id : undefined
      if (message.method === 'initialize') {
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from(`${JSON.stringify({ id, result: {} })}\n`))
        })
      }
      if (message.method === 'account/rateLimits/read') {
        queueMicrotask(() => {
          const reply = Buffer.from(`${JSON.stringify({ id, ...rateLimitsReply })}\n`)
          for (const chunk of replyChunks(reply)) {
            stdout.emit('data', chunk)
          }
        })
      }
    })
  })
  return Object.assign(new EventEmitter(), { stdout, stderr, stdin })
}

describe('Codex RPC rate-limit probe cleanup boundary', () => {
  it('does not resolve a successful read until the injected child termination finishes', async () => {
    const child = makeRpcChild()
    let finishTermination!: () => void
    const terminate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTermination = resolve
        })
    )
    let settled = false

    const result = readCodexRateLimitsViaRpc({
      child,
      codexCommand: 'codex',
      initTimeoutMs: 30_000,
      rpcTimeoutMs: 10_000,
      terminate
    }).then((value) => {
      settled = true
      return value
    })

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)

    finishTermination()
    await expect(result).resolves.toMatchObject({
      provider: 'codex',
      session: { usedPercent: 17 },
      status: 'ok'
    })
  })
})

describe('Codex RPC response framing', () => {
  it.each([false, true])(
    'rejects an oversized line (terminated: %s) and waits for child shutdown',
    async (terminated) => {
      const child = makeRpcChild(undefined, function* (reply) {
        const chunk = Buffer.alloc(64 * 1024, 97)
        for (let bytes = 0; bytes < NDJSON_MAX_LINE_BYTES; bytes += chunk.length) {
          yield chunk
        }
        yield terminated ? Buffer.concat([chunk, Buffer.from('\n'), reply]) : chunk
      })
      let finishTermination!: () => void
      const terminate = vi.fn(() => new Promise<void>((resolve) => (finishTermination = resolve)))
      let settled = false
      const result = readCodexRateLimitsViaRpc({
        child,
        codexCommand: 'codex',
        initTimeoutMs: 30_000,
        rpcTimeoutMs: 10_000,
        terminate
      }).then((value) => {
        settled = true
        return value
      })

      await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      finishTermination()
      await expect(result).resolves.toMatchObject({
        status: 'error',
        error: 'Codex usage response was too large'
      })
    }
  )

  it('accepts many bounded records whose total exceeds the per-line limit', async () => {
    const child = makeRpcChild(undefined, function* (reply) {
      const notification = Buffer.from(
        `${JSON.stringify({ method: 'notice', data: 'a'.repeat(64 * 1024) })}\n`
      )
      for (let bytes = 0; bytes <= NDJSON_MAX_LINE_BYTES; bytes += notification.length) {
        yield notification
      }
      yield Buffer.concat([Buffer.from('not json\nnull\n'), reply])
    })
    await expect(
      readCodexRateLimitsViaRpc({
        child,
        codexCommand: 'codex',
        initTimeoutMs: 30_000,
        rpcTimeoutMs: 10_000,
        terminate: async () => {}
      })
    ).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 17 } })
  })

  it('preserves UTF-8 characters split across output chunks', async () => {
    const child = makeRpcChild(
      { error: { code: -32603, message: 'quota 🚀 exceeded' } },
      function* (reply) {
        for (let index = 0; index < reply.length; index++) {
          yield reply.subarray(index, index + 1)
        }
      }
    )
    await expect(
      readCodexRateLimitsViaRpc({
        child,
        codexCommand: 'codex',
        initTimeoutMs: 30_000,
        rpcTimeoutMs: 10_000,
        terminate: async () => {}
      })
    ).resolves.toMatchObject({ status: 'error', error: 'quota 🚀 exceeded' })
  })

  it('retains valid windows when optional credit fields are malformed', async () => {
    const child = makeRpcChild({
      result: {
        rateLimits: { primary: { usedPercent: 17 }, credits: { balance: null } },
        rateLimitResetCredits: { availableCount: 'unknown' }
      }
    })
    await expect(
      readCodexRateLimitsViaRpc({
        child,
        codexCommand: 'codex',
        initTimeoutMs: 30_000,
        rpcTimeoutMs: 10_000,
        terminate: async () => {}
      })
    ).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 17 } })
  })
})

describe('Codex RPC rate-limit probe error classification', () => {
  async function readError(message: string) {
    return readCodexRateLimitsViaRpc({
      child: makeRpcChild({ error: { code: -32603, message } }),
      codexCommand: 'codex',
      initTimeoutMs: 30_000,
      rpcTimeoutMs: 10_000,
      terminate: vi.fn(async () => {})
    })
  }

  it('tags the captured app-server transport error as a network failure', async () => {
    const result = await readError(
      'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)'
    )
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('leaves an HTTP status failure unclassified', async () => {
    const result = await readError(
      'failed to fetch codex rate limits: unexpected status 429 Too Many Requests'
    )
    expect(result.status).toBe('error')
    expect(result.usageMetadata).toBeUndefined()
  })
})
