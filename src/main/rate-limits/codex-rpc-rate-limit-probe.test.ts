import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  readCodexRateLimitsViaRpc,
  type CodexRpcRateLimitChild
} from './codex-rpc-rate-limit-probe'

function makeRpcChild(): CodexRpcRateLimitChild {
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
            Buffer.from(
              `${JSON.stringify({
                id: message.id,
                result: { rateLimits: { primary: { usedPercent: 17 } } }
              })}\n`
            )
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
