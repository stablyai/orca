import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { SSH_MUX_REQUEST_TIMEOUT_CODE } from '../ssh/ssh-channel-multiplexer'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessions: vi.fn(),
  scanRemoteAiVaultSessions: vi.fn(),
  listClaudeSubagentSessions: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  getActiveSshAiVaultHostInfo: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(),
  requestActiveSshAiVaultSessionList: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle }
}))

vi.mock('../ai-vault/session-scanner', () => ({
  scanAiVaultSessions: mocks.scanAiVaultSessions
}))

vi.mock('../ai-vault/remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: mocks.scanRemoteAiVaultSessions
}))

vi.mock('../ai-vault/session-scanner-claude-subagents', () => ({
  listClaudeSubagentSessions: mocks.listClaudeSubagentSessions
}))

vi.mock('../wsl', () => ({
  getWslHomeAsync: mocks.getAiVaultWslHomeDirs,
  listWslDistrosAsync: vi.fn().mockResolvedValue([])
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

vi.mock('./ssh', () => ({
  getActiveSshAiVaultHostInfo: mocks.getActiveSshAiVaultHostInfo,
  getActiveSshAiVaultHostInfos: mocks.getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionList: mocks.requestActiveSshAiVaultSessionList
}))

const { _internals, registerAiVaultHandlers } = await import('./ai-vault')

const provider = {} as IFilesystemProvider

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanAiVaultSessions.mockResolvedValue(result([session('local', 'local-session')]))
  mocks.scanRemoteAiVaultSessions.mockResolvedValue(
    result([session('ssh:dev-box', 'remote-session')])
  )
  mocks.listClaudeSubagentSessions.mockResolvedValue({ sessions: [], issues: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(
    result([session('runtime:remote-server', 'runtime-session')])
  )
  mocks.getSshFilesystemProvider.mockReturnValue(provider)
  mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(null)
  mocks.getActiveSshAiVaultHostInfo.mockReturnValue(hostInfo('dev-box'))
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([hostInfo('dev-box')])
})

describe('listAiVaultSessions host routing', () => {
  it('routes local scope to the local scanner', async () => {
    await _internals.listAiVaultSessions({ executionHostScope: 'local', scopePaths: ['/repo'] })

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        scopePaths: ['/repo'],
        executionHostId: 'local'
      })
    )
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
  })

  it('routes SSH scope to only that SSH target', async () => {
    await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/home/ada/repo']
    })

    expect(mocks.scanAiVaultSessions).not.toHaveBeenCalled()
    expect(mocks.getActiveSshAiVaultHostInfo).toHaveBeenCalledWith('dev-box')
    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        executionHostId: 'ssh:dev-box',
        remoteHome: '/home/ada',
        scopePaths: ['/home/ada/repo']
      })
    )
  })

  it('forwards manual force refreshes through the SSH result cache', async () => {
    await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      force: true
    })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        executionHostId: 'ssh:dev-box'
      })
    )
  })

  it('uses one target-side relay scan when the SSH relay supports it', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(
      result([session('local', 'remote-session')])
    )

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/home/ada/repo']
    })

    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledWith(
      'dev-box',
      {
        limit: undefined,
        scopePaths: ['/home/ada/repo']
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
    expect(scanned.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      id: expect.stringContaining('ssh:dev-box:')
    })
  })

  it('marks oversized project scopes when sending their bounded relay form', async () => {
    const scopePaths = Array.from({ length: 80 }, (_, index) => `/repo/${index}`)
    mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(result([]))

    await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths
    })

    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledWith(
      'dev-box',
      {
        limit: undefined,
        scopePaths: scopePaths.slice(0, 64),
        scopePathsTruncated: true
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('caps and reports oversized project scopes on the SSH filesystem fallback', async () => {
    const scopePaths = Array.from({ length: 80 }, (_, index) => `/repo/${index}`)

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths
    })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({ scopePaths: scopePaths.slice(0, 64) })
    )
    expect(scanned.issues).toContainEqual(
      expect.objectContaining({
        kind: 'scope',
        message: expect.stringContaining('first 64 project paths')
      })
    )
  })

  it('coalesces concurrent cancellable requests into one scan', async () => {
    let resolveRelay: (() => void) | undefined
    mocks.requestActiveSshAiVaultSessionList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRelay = () => resolve(result([]))
        })
    )
    const args = { executionHostScope: 'ssh:dev-box' as const }

    const first = _internals.listAiVaultSessions(args, { signal: new AbortController().signal })
    const second = _internals.listAiVaultSessions(args, { signal: new AbortController().signal })
    await vi.waitFor(() => expect(resolveRelay).toBeDefined())

    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledTimes(1)
    resolveRelay?.()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('does not start a second remote crawl after the relay scan budget expires', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockRejectedValue(relayTimeoutError())

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box'
    })

    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
    expect(scanned.sessions).toEqual([])
    expect(scanned.issues[0]?.message).toContain('timed out')
  })

  it('does not cache a host-level relay failure', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockRejectedValue(relayTimeoutError())

    await _internals.listAiVaultSessions({ executionHostScope: 'ssh:dev-box' })
    await _internals.listAiVaultSessions({ executionHostScope: 'ssh:dev-box' })

    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledTimes(2)
  })

  it('falls back to the filesystem crawl after a non-timeout relay failure', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockRejectedValue(
      new Error('Invalid aiVault.listSessions response')
    )

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box'
    })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(scanned.sessions).toEqual([expect.objectContaining({ sessionId: 'remote-session' })])
  })

  it('falls back when a nonempty relay sessions array contains no valid rows', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockResolvedValue({
      sessions: [{ id: 42 }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    const scanned = await _internals.listAiVaultSessions({ executionHostScope: 'ssh:dev-box' })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(scanned.sessions).toEqual([expect.objectContaining({ sessionId: 'remote-session' })])
  })

  it('uses the relay scan without requiring the fallback filesystem provider', async () => {
    mocks.getSshFilesystemProvider.mockReturnValue(undefined)
    mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(
      result([session('local', 'remote-session')])
    )

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box'
    })

    expect(scanned.sessions).toHaveLength(1)
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
  })

  it('merges local plus connected SSH targets for all hosts', async () => {
    const result = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledWith(
      'dev-box',
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 15_000 })
    )
    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual(['ssh:dev-box', 'local'])
  })

  it('invalidates the all-host cache when the connected host set changes', async () => {
    mocks.getActiveSshAiVaultHostInfo.mockImplementation((targetId) => hostInfo(targetId))
    mocks.scanRemoteAiVaultSessions.mockImplementation(({ executionHostId }) =>
      Promise.resolve(result([session(executionHostId, `${executionHostId}-session`)]))
    )
    await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    mocks.getActiveSshAiVaultHostInfos.mockReturnValue([
      hostInfo('dev-box'),
      hostInfo('second-box')
    ])
    const scanResult = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(2)
    expect(scanResult.sessions.map((entry) => entry.executionHostId)).toContain('ssh:second-box')
  })

  it('keeps successful hosts when one SSH scan fails', async () => {
    mocks.getActiveSshAiVaultHostInfos.mockReturnValue([
      hostInfo('unavailable'),
      hostInfo('dev-box')
    ])
    mocks.getActiveSshAiVaultHostInfo.mockImplementation((targetId) => hostInfo(targetId))
    mocks.scanRemoteAiVaultSessions.mockImplementation(({ executionHostId }) =>
      executionHostId === 'ssh:unavailable'
        ? Promise.reject(new Error('relay unavailable'))
        : Promise.resolve(result([session('ssh:dev-box', 'remote-session')]))
    )

    const scanResult = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(
      mocks.scanRemoteAiVaultSessions.mock.calls.map(([scanArgs]) => scanArgs.executionHostId)
    ).toEqual(['ssh:unavailable', 'ssh:dev-box'])
    expect(scanResult.issues).toMatchObject([
      {
        executionHostId: 'ssh:unavailable',
        agent: 'codex',
        path: 'unavailable',
        message: 'relay unavailable'
      }
    ])
    expect(scanResult.sessions.map((entry) => entry.executionHostId)).toEqual([
      'ssh:dev-box',
      'local'
    ])
  })

  it('merges paired runtime servers for all hosts', async () => {
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [
        {
          environmentId: 'remote-server',
          executionHostId: 'runtime:remote-server'
        }
      ],
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    const result = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledWith(
      'remote-server',
      {
        executionHostScope: 'runtime:remote-server',
        force: false
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual([
      'runtime:remote-server',
      'ssh:dev-box',
      'local'
    ])
  })

  it('keeps local and SSH results when runtime host discovery fails', async () => {
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => {
        throw new Error('runtime store is invalid')
      },
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    const result = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanRuntimeAiVaultSessions).not.toHaveBeenCalled()
    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual(['ssh:dev-box', 'local'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'codex',
        path: 'runtime environments',
        message: 'runtime store is invalid'
      })
    ])
  })

  it('keeps SSH results when the local scan itself throws', async () => {
    // Why: `all` awaits every leg together, so an unguarded local throw (parse
    // cache load, WSL home resolution) would discard every host's sessions.
    mocks.scanAiVaultSessions.mockRejectedValue(new Error('session parse cache is corrupt'))
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [],
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    const result = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual(['ssh:dev-box'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'local',
        kind: 'host',
        path: 'this computer',
        message: 'session parse cache is corrupt'
      })
    ])
  })

  it('keeps local results when SSH host discovery fails', async () => {
    mocks.getActiveSshAiVaultHostInfos.mockImplementation(() => {
      throw new Error('relay session map is unavailable')
    })
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [],
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    const result = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(result.sessions.map((entry) => entry.executionHostId)).toEqual(['local'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'codex',
        path: 'SSH hosts',
        message: 'relay session map is unavailable'
      })
    ])
  })

  it('keeps direct runtime host scans on the normal runtime timeout', async () => {
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [],
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    await _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      force: true
    })

    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledWith(
      'remote-server',
      {
        executionHostScope: 'runtime:remote-server',
        force: true
      },
      {}
    )
  })

  it('returns a scan issue for a disconnected SSH target', async () => {
    mocks.getActiveSshAiVaultHostInfo.mockReturnValue(null)
    mocks.getSshFilesystemProvider.mockReturnValue(undefined)

    const result = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:disconnected'
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toMatchObject([
      {
        executionHostId: 'ssh:disconnected',
        agent: 'codex',
        path: 'disconnected'
      }
    ])
  })

  it('keeps host scope in the cache key', async () => {
    await _internals.listAiVaultSessions({ executionHostScope: 'local' })
    await _internals.listAiVaultSessions({ executionHostScope: 'ssh:dev-box' })

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('caches completed SSH scans by host and workspace scope', async () => {
    await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/home/ada/repo-a', '/home/ada/repo-b']
    })
    await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/home/ada/repo-b', '/home/ada/repo-a']
    })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('serves lower SSH depths from a larger completed scan', async () => {
    const base = { executionHostScope: 'ssh:dev-box' as const, scopePaths: ['/home/ada/repo'] }
    await _internals.listAiVaultSessions({ ...base, limit: 1000 })
    await _internals.listAiVaultSessions({ ...base, limit: 250 })
    await _internals.listAiVaultSessions({ ...base, limit: 500 })

    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('threads renderer cancellation into the SSH relay request', async () => {
    let relaySignal: AbortSignal | undefined
    mocks.requestActiveSshAiVaultSessionList.mockImplementation(
      (_targetId, _params, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          relaySignal = options.signal
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
        })
    )
    registerAiVaultHandlers()
    const event = { sender: { id: 7 } }
    const pending = getIpcHandler('aiVault:listSessions')(event, {
      executionHostScope: 'ssh:dev-box',
      requestToken: 'scan-1'
    })
    await vi.waitFor(() => expect(relaySignal).toBeDefined())

    await getIpcHandler('aiVault:cancelListSessions')(event, {
      requestToken: 'scan-1'
    })

    expect(relaySignal?.aborted).toBe(true)
    // Resolved, not rejected: Electron logs every rejected handler, and a
    // superseded scan is normal control flow rather than a failure.
    await expect(pending).resolves.toMatchObject({ cancelled: true, sessions: [] })
  })
})

describe('prepareSessionResume IPC', () => {
  it('awaits the host-local targeted resume preparation', async () => {
    const prepareSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    registerAiVaultHandlers({ prepareSessionResume })
    const registration = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'aiVault:prepareSessionResume'
    )
    const handler = registration?.[1] as
      | ((_event: unknown, args: unknown) => Promise<unknown>)
      | undefined
    const args = {
      agent: 'codex',
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'local'
    }

    await expect(handler?.({}, args)).resolves.toEqual({ useRealCodexHome: true })
    expect(prepareSessionResume).toHaveBeenCalledWith(args)
  })

  it('prepares saved-runtime sessions on the transcript-owning runtime', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    registerAiVaultHandlers({ prepareSessionResume, prepareRuntimeSessionResume })
    const args = {
      agent: 'codex' as const,
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'runtime:env-123' as const
    }

    await expect(getPrepareSessionResumeHandler()({}, args)).resolves.toEqual({
      useRealCodexHome: true
    })
    expect(prepareRuntimeSessionResume).toHaveBeenCalledWith('env-123', args)
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })

  it('preserves SSH session homes without reading their paths locally', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn()
    registerAiVaultHandlers({ prepareSessionResume, prepareRuntimeSessionResume })

    await expect(
      getPrepareSessionResumeHandler()(
        {},
        {
          agent: 'codex',
          filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
          codexHome: '/managed',
          executionHostId: 'ssh:dev-box'
        }
      )
    ).resolves.toEqual({ useRealCodexHome: false })
    expect(prepareSessionResume).not.toHaveBeenCalled()
    expect(prepareRuntimeSessionResume).not.toHaveBeenCalled()
  })
})

function getPrepareSessionResumeHandler(): (
  event: unknown,
  args: unknown
) => Promise<{ useRealCodexHome: boolean }> {
  const registration = mocks.ipcHandle.mock.calls.find(
    ([channel]) => channel === 'aiVault:prepareSessionResume'
  )
  if (!registration) {
    throw new Error('aiVault:prepareSessionResume was not registered')
  }
  return registration[1]
}

function getIpcHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel)
  if (!registration) {
    throw new Error(`${channel} was not registered`)
  }
  return registration[1]
}

describe('listAiVaultSubagentSessions gating', () => {
  const claudeRoot = join(homedir(), '.claude', 'projects')

  it('lists subagents for a local Claude session inside the projects root', async () => {
    const parentFilePath = join(claudeRoot, 'proj', 'sess.jsonl')

    await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath,
      executionHostId: 'local'
    })

    expect(mocks.listClaudeSubagentSessions).toHaveBeenCalledWith({ parentFilePath })
  })

  it('returns empty for a remote Claude session without reading the filesystem', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: join(claudeRoot, 'proj', 'sess.jsonl'),
      executionHostId: 'ssh:dev-box'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listClaudeSubagentSessions).not.toHaveBeenCalled()
  })

  it('rejects a path outside the Claude projects root', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: '/etc/secrets/subagents',
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listClaudeSubagentSessions).not.toHaveBeenCalled()
  })

  it('rejects a dot-segment traversal out of the Claude projects root', async () => {
    // Built with sep (not join) so the `..` segments survive into the arg.
    const traversal = [claudeRoot, '..', '..', '..', 'etc', 'passwd.jsonl'].join(sep)

    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: traversal,
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listClaudeSubagentSessions).not.toHaveBeenCalled()
  })

  it('resolves empty for malformed IPC payloads instead of throwing', async () => {
    const missing = await _internals.listAiVaultSubagentSessions(undefined)
    const badPath = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: 42 as unknown as string,
      executionHostId: 'local'
    })

    expect(missing).toEqual({ sessions: [], issues: [] })
    expect(badPath).toEqual({ sessions: [], issues: [] })
    expect(mocks.listClaudeSubagentSessions).not.toHaveBeenCalled()
  })

  it('returns empty for a non-Claude agent', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'codex',
      parentFilePath: join(claudeRoot, 'proj', 'sess.jsonl'),
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listClaudeSubagentSessions).not.toHaveBeenCalled()
  })
})

function hostInfo(targetId: string) {
  return {
    targetId,
    executionHostId: `ssh:${targetId}` as const,
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64')
  }
}

/** Mirrors the multiplexer's typed timeout: callers branch on the code, not on
 * the message text. */
function relayTimeoutError(): Error {
  return Object.assign(new Error('Request "aiVault.listSessions" timed out after 130000ms'), {
    code: SSH_MUX_REQUEST_TIMEOUT_CODE
  })
}

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: new Date().toISOString() }
}

function session(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId,
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt:
      sessionId === 'runtime-session'
        ? '2026-07-04T03:00:00.000Z'
        : sessionId === 'remote-session'
          ? '2026-07-04T02:00:00.000Z'
          : '2026-07-04T01:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
