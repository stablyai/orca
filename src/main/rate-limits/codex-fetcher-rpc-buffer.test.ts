import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(() => 'codex')
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

import { fetchCodexRateLimits, MAX_RPC_RESPONSE_LINE_BYTES } from './codex-fetcher'

function createRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.kill = vi.fn()
  return child
}

describe('Codex RPC response buffering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('processes a valid response after tens of thousands of tiny stdout chunks', async () => {
    vi.useRealTimers()
    const child = createRpcChild()
    childSpawnMock.mockReturnValue(child)
    child.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          const noise = Buffer.alloc(1_000_000, 0x78)
          for (let offset = 0; offset < noise.byteLength; offset += 16) {
            child.stdout.emit('data', noise.subarray(offset, offset + 16))
          }
          child.stdout.emit(
            'data',
            Buffer.from(`\n${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (message.method === 'account/rateLimits/read') {
        setTimeout(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  rateLimits: {
                    primary: { usedPercent: 7 },
                    secondary: { usedPercent: 12 }
                  },
                  rateLimitResetCredits: {
                    availableCount: 0,
                    nextExpiresAt: Date.now() + 60_000
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
      return true
    })

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })

    await expect(resultPromise).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 7 },
      weekly: { usedPercent: 12 }
    })
  })

  it('kills the RPC process before retaining an oversized line', async () => {
    vi.useRealTimers()
    const child = createRpcChild()
    childSpawnMock.mockReturnValue(child)
    child.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line) as { method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.alloc(MAX_RPC_RESPONSE_LINE_BYTES + 1, 0x78))
        }, 0)
      }
      return true
    })

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: `RPC response exceeded ${MAX_RPC_RESPONSE_LINE_BYTES} byte line limit`
    })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.stdout.listenerCount('data')).toBe(0)
  })
})
