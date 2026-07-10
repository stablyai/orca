import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

vi.mock('./codex-auth-presence', () => ({
  codexAuthExists: vi.fn(() => true)
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { codexAuthExists } from './codex-auth-presence'

function makeRpcChild() {
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

// Why: split from codex-fetcher.test.ts so that suite stays under max-lines
// while covering multi-meter window mapping thoroughly.
describe('fetchCodexRateLimits multi-meter windows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.mocked(codexAuthExists).mockResolvedValue(true)
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('normalizes Codex RPC remaining-minute windows to fixed display durations', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (msg.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  rateLimits: {
                    primary: { usedPercent: 0, windowDurationMins: 299 },
                    secondary: { usedPercent: 0, windowDurationMins: 10079 }
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.windowMinutes).toBe(10080)
  })

  it('surfaces additional rateLimitsByLimitId buckets alongside preferred session/weekly', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (msg.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  rateLimits: {
                    limitId: 'codex',
                    primary: { usedPercent: 10, windowDurationMins: 299 },
                    secondary: { usedPercent: 20, windowDurationMins: 10079 }
                  },
                  rateLimitsByLimitId: {
                    codex: {
                      limitId: 'codex',
                      limitName: 'Codex',
                      primary: { usedPercent: 10 },
                      secondary: { usedPercent: 20 }
                    },
                    codex_other: {
                      limitId: 'codex_other',
                      limitName: 'Codex other',
                      primary: { usedPercent: 40 },
                      secondary: { usedPercent: 55 }
                    }
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result).toMatchObject({
      provider: 'codex',
      session: { usedPercent: 10, windowMinutes: 300 },
      weekly: { usedPercent: 20, windowMinutes: 10080 },
      status: 'ok'
    })
    // Preferred codex meters stay on session/weekly only — buckets lists extras.
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Codex other', usedPercent: 40, windowMinutes: 300 }),
      expect.objectContaining({
        name: 'Codex other weekly',
        usedPercent: 55,
        windowMinutes: 10080
      })
    ])
  })

  it('infers additional bucket windows from windowDurationMins instead of forcing 5h/weekly', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (msg.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  rateLimits: {
                    limitId: 'codex',
                    primary: { usedPercent: 10, windowDurationMins: 299 },
                    secondary: { usedPercent: 20, windowDurationMins: 10079 }
                  },
                  rateLimitsByLimitId: {
                    codex: {
                      limitId: 'codex',
                      primary: { usedPercent: 10 },
                      secondary: { usedPercent: 20 }
                    },
                    short_meter: {
                      limitId: 'short_meter',
                      limitName: 'Short',
                      // Why: remaining ~50 minutes of a 1h window — must not become 5h.
                      primary: { usedPercent: 40, windowDurationMins: 50 },
                      secondary: { usedPercent: 10, windowDurationMins: 1400 }
                    }
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Short', usedPercent: 40, windowMinutes: 60 }),
      expect.objectContaining({
        name: 'Short weekly',
        usedPercent: 10,
        windowMinutes: 1440
      })
    ])
  })
})
