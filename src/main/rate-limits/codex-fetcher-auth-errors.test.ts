import type * as ChildProcessModule from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import type * as ProviderLedgerModule from '../provider-process/provider-process-ledger'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

// The probe's child runs in-process here; the worker transport has its own suite.
vi.mock(
  '../worker-thread-child-process/worker-thread-child-process',
  () =>
    import('../worker-thread-child-process/worker-thread-child-process-in-process.test-fixtures')
)
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: childSpawnMock
}))

// The recovery's supervised stop imports the process-table reader, which needs the real execFile.
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

// Auth gate is covered separately; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild() {
  type RpcChild = EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  const kill = vi.fn(() => {
    exitNow()
    return true
  })
  const child: RpcChild = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    kill,
    exitCode: null
  })
  return child
}

describe('fetchCodexRateLimits auth errors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns Codex RPC auth refresh errors without masking them behind a fallback', async () => {
    const rpcChild = makeRpcChild()
    const authError =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'

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
                error: { code: -32000, message: authError }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.waitFor(() => expect(rpcChild.stdin.write).toHaveBeenCalled(), { interval: 0 })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: authError
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('returns the app-server chatgpt-auth-required error without falling back', async () => {
    const rpcChild = makeRpcChild()
    const authError = 'chatgpt authentication required to read rate limits'

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
                error: { code: -32600, message: authError }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.waitFor(() => expect(rpcChild.stdin.write).toHaveBeenCalled(), { interval: 0 })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: authError
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })
})

vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHostModule>()),
  spawnProcess: (spec: ProcessSpec) => childSpawnMock(spec.program, spec.args ?? [], spec)
}))

vi.mock('../provider-process/provider-process-ledger', async (original) => ({
  ...(await original<typeof ProviderLedgerModule>()),
  recordProviderLaunch: () => ({
    capture: async () => {},
    retire: async () => {},
    members: () => []
  })
}))
