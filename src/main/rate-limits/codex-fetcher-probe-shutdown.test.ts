import { registerScriptedProviderChild } from '../provider-process/mock-provider-process-group.test-support'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type * as ProcessHostModule from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { readPosixProcessRow } from '../provider-process/provider-process-row-read'
import * as ledger from '../provider-process/provider-process-ledger'
import { getAppEnvironment } from '../../shared/app-environment'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

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

// Auth gate is covered by codex-auth-presence.test.ts; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits as fetch } from './codex-fetcher'
const fetchCodexRateLimits = (options?: Parameters<typeof fetch>[0]) =>
  fetch({ codexHomePath: getAppEnvironment().getPath('userData'), ...options })
import { probeCodexAuthPresence } from './codex-auth-presence'

function makeRpcChild() {
  const state: { exitCode: number | null } = { exitCode: null }
  const child = Object.assign(createFakePipedChild(9_999_999), state, {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  })
  // EOF and a signal both report an actual scripted exit.
  const exitNow = (): boolean => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    return true
  }
  child.stdin.end.mockImplementation(exitNow)
  child.kill.mockImplementation(exitNow)
  child.once('exit', (code, signal) => child.emit('close', code, signal))
  return child
}

// Flush real inventory I/O without advancing the fake deadline clock.
async function atCurrentTime(assertion: () => unknown, ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.waitFor(assertion, { interval: 0 })
}

async function initialized(child: ReturnType<typeof makeRpcChild>): Promise<void> {
  await atCurrentTime(() => expect(child.stdin.write).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(0)
}

function respondToRpcRateLimitRead(
  rpcChild: ReturnType<typeof makeRpcChild>,
  rateLimits: unknown
): void {
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
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { rateLimits } })}\n`)
        )
      }, 0)
    }
  })
}

describe('fetchCodexRateLimits probe shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('present')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('gives a cold app-server the full boot budget before any deadline fires', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        // Why: cold starts (auth refresh included) are documented at 10-25s;
        // the old 10s deadline killed them mid-auth.
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 20_000)
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
                  rateLimits: { primary: { usedPercent: 3 }, secondary: { usedPercent: 4 } }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await initialized(rpcChild)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(rpcChild.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    await expect(resultPromise).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 3 },
      weekly: { usedPercent: 4 }
    })
  })

  it('arms the read deadline after initialize and drains SIGTERM before SIGKILL', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const rpcChild = makeRpcChild()
    // Stubborn child: it ignores stdin EOF, survives SIGTERM, dies on SIGKILL.
    rpcChild.stdin.end = vi.fn()
    rpcChild.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        rpcChild.exitCode = 0
        rpcChild.emit('exit', 0, null)
      }
      return true
    })
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
      // The rate-limits read never answers, so the request deadline expires.
    })

    try {
      const resultPromise = fetchCodexRateLimits()
      await initialized(rpcChild)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(rpcChild.kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(rpcChild.stdin.end).toHaveBeenCalledTimes(1)
      expect(rpcChild.kill).not.toHaveBeenCalled()
      await atCurrentTime(() => expect(rpcChild.kill).toHaveBeenCalledWith('SIGTERM'), 1_000)
      expect(rpcChild.kill).not.toHaveBeenCalledWith('SIGKILL')

      await atCurrentTime(() => expect(rpcChild.kill).toHaveBeenCalledWith('SIGKILL'), 3_000)
      await expect(resultPromise).resolves.toMatchObject({
        status: 'error',
        error: 'RPC timeout'
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not spawn a second probe for the same home while one is still running', async () => {
    const firstChild = makeRpcChild()
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    const first = fetchCodexRateLimits({
      codexHomePath: '/managed/home-a'
    })
    await initialized(firstChild)
    const second = fetchCodexRateLimits({
      codexHomePath: '/managed/home-a'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(childSpawnMock).toHaveBeenCalledTimes(1)

    firstChild.exitCode = 0
    firstChild.emit('exit', 0, null)
    firstChild.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await atCurrentTime(() => expect(childSpawnMock).toHaveBeenCalledTimes(2), 1)
    await expect(second).resolves.toMatchObject({ status: 'ok' })
    await first
  })

  it('joins predecessor cleanup after early raw quota close while another home proceeds', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild(),
      nextChild = makeRpcChild(),
      otherChild = makeRpcChild()
    firstChild.pid = 9_999_991
    nextChild.pid = 9_999_992
    otherChild.pid = 9_999_993
    firstChild.stdin.end = vi.fn()
    const writer = { pid: 9_999_990, pgid: firstChild.pid, startedAt: 'captured-writer' }
    vi.spyOn(ledger, 'recordProviderLaunch').mockReturnValueOnce({
      capture: async () => {},
      retire: async () => {},
      members: () => [writer]
    })
    let writerLive = true
    const gate = Promise.withResolvers<DescendantTreeVerdict>()
    const group = await import('../provider-process/provider-process-group')
    vi.spyOn(group, 'observeProviderGroup').mockImplementation(async (pid) =>
      pid === firstChild.pid ? gate.promise : 'exited'
    )
    const read = vi.mocked(readPosixProcessRow).getMockImplementation()!
    vi.mocked(readPosixProcessRow).mockImplementation((pid, ...args) =>
      pid === writer.pid
        ? Promise.resolve(writerLive ? { ...writer, ppid: 1, startResolution: 'clock-tick' } : null)
        : read(pid, ...args)
    )
    childSpawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(otherChild)
      .mockReturnValueOnce(nextChild)
    respondToRpcRateLimitRead(otherChild, { primary: { usedPercent: 3 } })
    respondToRpcRateLimitRead(nextChild, { primary: { usedPercent: 4 } })
    const pending: Promise<unknown>[] = []
    const controller = new AbortController()
    const home = '/managed/early-close'
    const request = (codexHomePath = home) => {
      const result = fetchCodexRateLimits({ codexHomePath, signal: controller.signal })
      pending.push(result)
      return result
    }
    try {
      const first = request()
      await initialized(firstChild)
      firstChild.exitCode = 1
      firstChild.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(0)
      await expect(first).resolves.toMatchObject({ status: 'error' })
      const same = request()
      const other = request(`${home}-other`)
      await initialized(otherChild)
      await atCurrentTime(() => expect(childSpawnMock).toHaveBeenCalledTimes(2), 1)
      await expect(other).resolves.toMatchObject({ status: 'ok' })
      writerLive = false
      gate.resolve('exited')
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(same).resolves.toMatchObject({ status: 'ok' })
      expect(childSpawnMock).toHaveBeenCalledTimes(3)
    } finally {
      writerLive = false
      gate.resolve('exited')
      controller.abort()
      for (const child of [firstChild, otherChild, nextChild]) {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
        }
      }
      await vi.runAllTimersAsync()
      vi.useRealTimers()
      await Promise.allSettled(pending)
      vi.mocked(readPosixProcessRow).mockImplementation(read)
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the home lock through child errors until the failed probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: '/managed/home-error'
      })
      await initialized(firstChild)
      firstChild.emit('error', new Error('stdio failed'))
      const second = fetchCodexRateLimits({
        codexHomePath: '/managed/home-error'
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(firstChild.stdin.end).toHaveBeenCalledOnce()
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM'), 1_000)
      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL'), 3_000)
      await atCurrentTime(() => expect(childSpawnMock).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'stdio failed' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it.each([
    { failAt: 1, phase: 'initial request' },
    { failAt: 2, phase: 'initialized notification' },
    { failAt: 3, phase: 'rate-limit request' }
  ])('keeps the home lock when the $phase stdin write throws', async ({ failAt, phase }) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    let writeCount = 0
    firstChild.stdin.write.mockImplementation((line: string) => {
      writeCount += 1
      if (writeCount === failAt) {
        throw new Error(`${phase} stdin failed`)
      }
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          firstChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
    })
    firstChild.stdin.end = vi.fn()
    firstChild.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })
    const home = `/managed/home-stdin-error-${failAt}`

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: home
      })
      await initialized(firstChild)
      expect(firstChild.stdin.end).toHaveBeenCalledOnce()

      const second = fetchCodexRateLimits({
        codexHomePath: home
      })
      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM'), 1_000)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)

      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL'), 1)
      await atCurrentTime(() => expect(childSpawnMock).toHaveBeenCalledTimes(2), 1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({
        status: 'error',
        error: `${phase} stdin failed`
      })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('observes asynchronous stdin failures and keeps the lock until the probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: '/managed/home-async-stdin-error'
      })
      await initialized(firstChild)
      firstChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      const second = fetchCodexRateLimits({
        codexHomePath: '/managed/home-async-stdin-error'
      })

      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM'), 1_000)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await atCurrentTime(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL'), 1)
      await atCurrentTime(() => expect(childSpawnMock).toHaveBeenCalledTimes(2), 1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'write EPIPE' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})

vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    spawnProcess: (spec: ProcessSpec) =>
      spec.program === 'codex'
        ? registerScriptedProviderChild(childSpawnMock(spec.program, spec.args ?? [], spec))
        : actual.spawnProcess(spec)
  }
})

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
