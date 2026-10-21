import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  readCodexRateLimitsViaRpc,
  type CodexRpcRateLimitChild
} from './codex-rpc-rate-limit-probe'

function makeRpcChild(
  rateLimitsReply: Record<string, unknown> = {
    result: { rateLimits: { primary: { usedPercent: 17 } } }
  }
): CodexRpcRateLimitChild {
  const child = new EventEmitter() as EventEmitter & CodexRpcRateLimitChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        queueMicrotask(() => {
          ;(child.stdout as EventEmitter).emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)
          )
        })
      }
      if (message.method === 'account/rateLimits/read') {
        queueMicrotask(() => {
          ;(child.stdout as EventEmitter).emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: message.id, ...rateLimitsReply })}\n`)
          )
        })
      }
    })
  })
  return child
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
    expect((child.stdout as EventEmitter).listenerCount('data')).toBe(0)
    expect((child.stderr as EventEmitter).listenerCount('data')).toBe(0)

    finishTermination()
    await expect(result).resolves.toMatchObject({
      provider: 'codex',
      session: { usedPercent: 17 },
      status: 'ok'
    })
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
