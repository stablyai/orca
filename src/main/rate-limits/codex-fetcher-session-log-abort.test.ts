import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, readLatestCodexSessionUsedPercentMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  readLatestCodexSessionUsedPercentMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))
vi.mock('./codex-session-log-usage', () => ({
  readLatestCodexSessionUsedPercent: readLatestCodexSessionUsedPercentMock
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('Codex session-log fallback abort handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: 'access-token', account_id: 'account-id' } })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('discards a session-log result if the fetch aborts while it was being read', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    const controller = new AbortController()
    readLatestCodexSessionUsedPercentMock.mockImplementationOnce(async () => {
      controller.abort()
      return 17
    })

    const resultPromise = fetchCodexRateLimits({
      signal: controller.signal,
      allowPtyFallback: false
    })
    await vi.advanceTimersByTimeAsync(0)
    rpcChild.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
  })
})
