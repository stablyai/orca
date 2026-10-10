import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { probeDaemonSocketMock, probeSocketConnectMock, retireTokenlessDaemonMock } = vi.hoisted(
  () => ({
    probeDaemonSocketMock: vi.fn<(socketPath: string) => Promise<boolean>>(),
    probeSocketConnectMock: vi.fn<(socketPath: string) => Promise<string>>(),
    retireTokenlessDaemonMock: vi.fn(async () => true)
  })
)

vi.mock('./daemon-launch-paths', () => ({
  getDaemonHistoryDir: () => '/fake/history',
  probeDaemonSocket: probeDaemonSocketMock
}))
vi.mock('./daemon-endpoint-probe', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeSocketConnect: probeSocketConnectMock
}))
vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class {
    constructor(readonly options: { protocolVersion: number }) {}
  }
}))
vi.mock('./daemon-tokenless-retirement', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retireTokenlessDaemon: retireTokenlessDaemonMock
}))
vi.mock('./types', () => ({ PREVIOUS_DAEMON_PROTOCOL_VERSIONS: [36] }))

import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'

const DAEMON_PID = 424_242

describe('createLegacyDaemonAdapters stale-artifact cleanup', () => {
  let runtimeDir: string
  let pidPath: string
  let tokenPath: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-legacy-daemon-'))
    pidPath = join(runtimeDir, 'daemon-v36.pid')
    tokenPath = join(runtimeDir, 'daemon-v36.token')
    writeFileSync(pidPath, JSON.stringify({ pid: DAEMON_PID, startedAtMs: 1 }))
    writeFileSync(tokenPath, 'secret')
    probeDaemonSocketMock.mockReset().mockResolvedValue(false)
    probeSocketConnectMock.mockReset().mockResolvedValue('missing')
    retireTokenlessDaemonMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  function mockKill(code: string | null): void {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (code) {
        throw Object.assign(new Error(code), { code })
      }
      return true
    })
  }

  async function run(): Promise<unknown[]> {
    const pending = createLegacyDaemonAdapters(runtimeDir, '/fake/history')
    await vi.runAllTimersAsync()
    return pending
  }

  it('keeps the token when the pid probe is EPERM, which Windows reports for a live process', async () => {
    mockKill('EPERM')
    await expect(run()).resolves.toEqual([])
    expect(existsSync(tokenPath)).toBe(true)
    expect(existsSync(pidPath)).toBe(true)
  })

  it('keeps the token when the pid is gone but the endpoint probe proves nothing', async () => {
    // The field failure: pid record missing, pipe still served by the daemon but slow to answer.
    rmSync(pidPath)
    probeSocketConnectMock.mockResolvedValue('unknown')
    await run()
    expect(existsSync(tokenPath)).toBe(true)
  })

  it('keeps the token when the endpoint answers the classifying probe', async () => {
    mockKill('ESRCH')
    probeSocketConnectMock.mockResolvedValue('connected')
    await run()
    expect(existsSync(tokenPath)).toBe(true)
  })

  it('retries the adapter probe while the recorded daemon is alive', async () => {
    mockKill(null)
    probeDaemonSocketMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(run()).resolves.toHaveLength(1)
    expect(existsSync(tokenPath)).toBe(true)
  })

  it('does not retry when no pid record exists, so absent versions stay cheap', async () => {
    rmSync(pidPath)
    rmSync(tokenPath)
    await run()
    expect(probeDaemonSocketMock).toHaveBeenCalledTimes(1)
  })

  it('removes pid and token once both the pid and the endpoint prove the daemon exited', async () => {
    mockKill('ESRCH')
    await expect(run()).resolves.toEqual([])
    expect(existsSync(tokenPath)).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('leaves a replacement published between the checks and cleanup untouched', async () => {
    mockKill('ESRCH')
    const replacementPid = JSON.stringify({ pid: 1, startedAtMs: 2, launchNonce: 'next' })
    probeSocketConnectMock.mockImplementation(async () => {
      writeFileSync(pidPath, replacementPid)
      writeFileSync(tokenPath, 'replacement-secret')
      return 'missing'
    })
    await run()
    expect(readFileSync(pidPath, 'utf8')).toBe(replacementPid)
    expect(readFileSync(tokenPath, 'utf8')).toBe('replacement-secret')
  })

  it('probes a salvaged pid from a torn pid record before deleting anything', async () => {
    writeFileSync(pidPath, `{"pid":${DAEMON_PID},"startedAt`)
    mockKill('EPERM')
    await run()
    expect(process.kill).toHaveBeenCalledWith(DAEMON_PID, 0)
    expect(existsSync(tokenPath)).toBe(true)
  })

  it('retires a daemon that answers but whose token is gone, instead of adopting it', async () => {
    probeDaemonSocketMock.mockResolvedValue(true)
    rmSync(tokenPath)
    await expect(run()).resolves.toEqual([])
    expect(retireTokenlessDaemonMock).toHaveBeenCalledWith(
      expect.stringContaining('v36'),
      tokenPath,
      36
    )
  })

  it('adopts a daemon that answers and still has its token', async () => {
    probeDaemonSocketMock.mockResolvedValue(true)
    await expect(run()).resolves.toHaveLength(1)
    expect(retireTokenlessDaemonMock).not.toHaveBeenCalled()
  })
})
