import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { SSH_MUX_REQUEST_TIMEOUT_CODE } from '../ssh/ssh-channel-multiplexer'

const requestActiveSshAiVaultSessionList = vi.fn()
const getActiveSshAiVaultHostInfo = vi.fn()
const getSshFilesystemProvider = vi.fn()
const scanRemoteAiVaultSessions = vi.fn()

vi.mock('../ipc/ssh', () => ({
  requestActiveSshAiVaultSessionList: (...args: unknown[]) =>
    requestActiveSshAiVaultSessionList(...args),
  getActiveSshAiVaultHostInfo: (...args: unknown[]) => getActiveSshAiVaultHostInfo(...args)
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: (...args: unknown[]) => getSshFilesystemProvider(...args),
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH filesystem is unavailable.'
}))

vi.mock('./remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: (...args: unknown[]) => scanRemoteAiVaultSessions(...args)
}))

const { scanSshAiVaultSessions } = await import('./ssh-session-list')

describe('scanSshAiVaultSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    getActiveSshAiVaultHostInfo.mockReturnValue({ remoteHome: '/home/dev', hostPlatform: 'linux' })
    getSshFilesystemProvider.mockReturnValue({})
  })

  it('returns at the deadline when the legacy crawl ignores abort', async () => {
    // Relay without the method resolves null, so the leg falls through to the
    // desktop crawl — which used to run unbounded even under an all-host budget.
    vi.useFakeTimers()
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    let fallbackSignal: AbortSignal | undefined
    scanRemoteAiVaultSessions.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      fallbackSignal = signal
      return new Promise(() => {})
    })

    const resultPromise = scanSshAiVaultSessions('dev-box', undefined, { timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    const result = await Promise.race([resultPromise, Promise.resolve('still-pending' as const)])

    expect(result).not.toBe('still-pending')
    expect(fallbackSignal?.aborted).toBe(true)
    if (result === 'still-pending') {
      return
    }
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:dev-box',
        kind: 'host',
        message: 'Agent Session History scan timed out after 20ms on this SSH host.'
      })
    ])
  })

  it('leaves the crawl unbounded when no budget was requested', async () => {
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockResolvedValue(emptyResult())

    await scanSshAiVaultSessions('dev-box')

    expect(scanRemoteAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined })
    )
  })

  it('reports an unexpected crawl failure as a host issue instead of rejecting', async () => {
    // Why: `all` scope awaits every host leg together, so a throw here would
    // discard the local sessions alongside this host's.
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockRejectedValue(new TypeError('provider blew up'))

    const result = await scanSshAiVaultSessions('dev-box')

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ executionHostId: 'ssh:dev-box', message: 'provider blew up' })
    ])
  })

  it('bounds the relay round trip separately from the whole leg', async () => {
    // The relay needs seconds to walk a real remote home; only the leg total
    // has to stay short enough that one host cannot hold the merge open.
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockResolvedValue(emptyResult())

    await scanSshAiVaultSessions('dev-box', undefined, {
      timeoutMs: 20_000,
      relayTimeoutMs: 15_000
    })

    expect(requestActiveSshAiVaultSessionList).toHaveBeenCalledWith(
      'dev-box',
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 15_000 })
    )
  })

  it('keeps a relay scan that outran the old three-second bound', async () => {
    // Regression: the shared 3s budget emptied healthy hosts in the all-hosts
    // view. A relay answering inside the scan budget must keep its sessions.
    requestActiveSshAiVaultSessionList.mockImplementation(
      (_targetId: string, _params: unknown, options: { timeoutMs?: number }) =>
        (options.timeoutMs ?? 0) > 3_000
          ? Promise.resolve({
              sessions: [remoteSession()],
              issues: [],
              scannedAt: '2026-08-02T00:00:00.000Z'
            })
          : Promise.reject(relayTimeoutError())
    )

    const result = await scanSshAiVaultSessions('dev-box', undefined, {
      timeoutMs: 20_000,
      relayTimeoutMs: 15_000
    })

    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'remote-session' })])
    expect(scanRemoteAiVaultSessions).not.toHaveBeenCalled()
  })

  it('reports a host issue when the relay timed out on a real scan budget', async () => {
    // A relay that had a fair scan window will not answer faster over the far
    // slower filesystem crawl, so retrying it only stalls the merge.
    requestActiveSshAiVaultSessionList.mockRejectedValue(relayTimeoutError())

    const result = await scanSshAiVaultSessions('dev-box', undefined, {
      timeoutMs: 20_000,
      relayTimeoutMs: 15_000
    })

    expect(scanRemoteAiVaultSessions).not.toHaveBeenCalled()
    expect(result.issues).toEqual([
      expect.objectContaining({ executionHostId: 'ssh:dev-box', kind: 'host' })
    ])
  })

  it('still falls back when the relay budget was too short for a fair attempt', async () => {
    requestActiveSshAiVaultSessionList.mockRejectedValue(relayTimeoutError())
    scanRemoteAiVaultSessions.mockResolvedValue({
      sessions: [remoteSession()],
      issues: [],
      scannedAt: '2026-08-02T00:00:00.000Z'
    })

    const result = await scanSshAiVaultSessions('dev-box', undefined, {
      timeoutMs: 3_000,
      relayTimeoutMs: 2_000
    })

    expect(scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'remote-session' })])
  })

  it('does not treat an unrelated error mentioning a timeout as a relay timeout', async () => {
    requestActiveSshAiVaultSessionList.mockRejectedValue(
      new Error('the remote agent timed out after loading its index')
    )
    scanRemoteAiVaultSessions.mockResolvedValue({
      sessions: [remoteSession()],
      issues: [],
      scannedAt: '2026-08-02T00:00:00.000Z'
    })

    const result = await scanSshAiVaultSessions('dev-box', undefined, {
      timeoutMs: 20_000,
      relayTimeoutMs: 15_000
    })

    expect(scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'remote-session' })])
  })

  it('reports the relay error when the fallback crawl recovered nothing', async () => {
    // Otherwise a broken relay over an empty crawl reads as a healthy but empty
    // host, and the panel shows no reason for the missing sessions.
    requestActiveSshAiVaultSessionList.mockRejectedValue(new Error('relay method exploded'))
    scanRemoteAiVaultSessions.mockResolvedValue(emptyResult())

    const result = await scanSshAiVaultSessions('dev-box')

    expect(result.issues).toEqual([
      expect.objectContaining({ executionHostId: 'ssh:dev-box', message: 'relay method exploded' })
    ])
  })

  it('still propagates a caller cancellation', async () => {
    const controller = new AbortController()
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockImplementation(() => new Promise(() => {}))

    const result = scanSshAiVaultSessions('dev-box', undefined, {
      signal: controller.signal,
      timeoutMs: 5_000
    })
    await vi.waitFor(() => expect(scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function emptyResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: '2026-08-02T00:00:00.000Z' }
}

/** Mirrors the multiplexer's typed timeout: the leg branches on the code, not
 * on the message text, so a look-alike message must not take that branch. */
function relayTimeoutError(): Error {
  return Object.assign(new Error('Request "aiVault.listSessions" timed out after 15000ms'), {
    code: SSH_MUX_REQUEST_TIMEOUT_CODE
  })
}

// Relay rows are re-validated before they are trusted, so this has to satisfy
// the full session schema rather than a partial stub.
function remoteSession(): AiVaultSession {
  return {
    id: 'ssh:dev-box:codex:remote-session:/home/dev/remote-session.jsonl',
    executionHostId: 'ssh:dev-box',
    agent: 'codex',
    sessionId: 'remote-session',
    title: 'remote-session',
    cwd: '/home/dev/repo',
    branch: null,
    model: null,
    filePath: '/home/dev/remote-session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-08-02T00:00:00.000Z',
    modifiedAt: '2026-08-02T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume remote-session',
    subagent: null
  }
}
