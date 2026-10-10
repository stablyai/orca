import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcess from '../../shared/child-process/run-process'

const { childSpawnMock, readFileMock, netFetchMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcess>()),
  spawnProcess: (spec: { program: string; args?: readonly string[] }) =>
    childSpawnMock(spec.program, spec.args ?? [], spec)
}))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: () => false }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: vi.fn(() => 'present') }))

import { fetchCodexRateLimits } from './codex-fetcher'

const PROXY = { httpProxyUrl: 'http://127.0.0.1:1080', httpProxyBypassRules: 'localhost;127.0.0.1' }

type ProbeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
}

function closingRpcChild(): ProbeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn(() => true),
    exitCode: null
  })
}

async function fetchWithFailedProbe(codexHomePath?: string) {
  const child = closingRpcChild()
  childSpawnMock.mockReturnValue(child)
  readFileMock.mockResolvedValue(
    JSON.stringify({ tokens: { access_token: 'access-token', account_id: 'account-id' } })
  )
  netFetchMock.mockResolvedValue(new Response(null, { status: 503 }))
  const result = fetchCodexRateLimits({ networkProxySettings: PROXY, codexHomePath })
  await vi.advanceTimersByTimeAsync(0)
  child.exitCode = 1
  child.emit('close', 1, null)
  return result
}

describe('Codex usage through the proxy set in Orca', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('global fetch skips the proxy set in Orca')))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts the app-server probe with the configured proxy', async () => {
    await fetchWithFailedProbe()

    const [, , spawnSpec] = childSpawnMock.mock.calls[0]
    expect(spawnSpec.env).toEqual(
      expect.objectContaining({
        HTTPS_PROXY: 'http://127.0.0.1:1080',
        HTTP_PROXY: 'http://127.0.0.1:1080',
        NO_PROXY: 'localhost,127.0.0.1'
      })
    )
  })

  it('carries the configured proxy across wsl.exe into a WSL Codex probe', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await fetchWithFailedProbe('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }

    const [program, , spawnSpec] = childSpawnMock.mock.calls[0]
    expect(program).toBe('wsl.exe')
    expect(spawnSpec.env.WSLENV.split(':')).toEqual(
      expect.arrayContaining(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'])
    )
  })

  it("reads backend usage through Electron's network stack, which follows the configured proxy", async () => {
    await fetchWithFailedProbe()

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' })
      })
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
