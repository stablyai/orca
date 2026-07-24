import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

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

describe('fetchCodexRateLimits multi-meter windows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the preferred meter in session/weekly and surfaces inferred extra buckets', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (message.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  rateLimits: {
                    limitId: 'codex',
                    primary: { usedPercent: 10, windowDurationMins: 299 },
                    secondary: { usedPercent: 20, windowDurationMins: 10079 }
                  },
                  rateLimitsByLimitId: {
                    short_meter: {
                      limitId: 'short_meter',
                      limitName: 'Short',
                      primary: { usedPercent: 40, windowDurationMins: 50 },
                      secondary: { usedPercent: 10, windowDurationMins: 1400 }
                    },
                    codex: {
                      limitId: 'codex',
                      primary: { usedPercent: 99 },
                      secondary: { usedPercent: 98 }
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
      // Why: preferred session/weekly stay classification-normalized (upstream #10136);
      // extra meters still surface via buckets with reported durations.
      session: { usedPercent: 10, windowMinutes: 300 },
      weekly: { usedPercent: 20, windowMinutes: 10080 },
      status: 'ok'
    })
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Short', usedPercent: 40, windowMinutes: 50 }),
      expect.objectContaining({ name: 'Short weekly', usedPercent: 10, windowMinutes: 1400 })
    ])
  })
})
