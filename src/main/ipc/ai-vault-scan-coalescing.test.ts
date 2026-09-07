import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessionsInWorker: vi.fn(),
  resolveAiVaultSessionTitlesInWorker: vi.fn(),
  scanRemoteAiVaultSessions: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  getActiveSshAiVaultHostInfo: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(),
  requestActiveSshAiVaultSessionList: vi.fn(),
  requestActiveSshAiVaultSessionTitles: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: mocks.ipcHandle } }))
vi.mock('../ai-vault/session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker: mocks.scanAiVaultSessionsInWorker,
  resolveAiVaultSessionTitlesInWorker: mocks.resolveAiVaultSessionTitlesInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
}))
vi.mock('../ai-vault/remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: mocks.scanRemoteAiVaultSessions
}))
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([])
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH unavailable',
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))
vi.mock('./ssh', () => ({
  getActiveSshAiVaultHostInfo: mocks.getActiveSshAiVaultHostInfo,
  getActiveSshAiVaultHostInfos: mocks.getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionList: mocks.requestActiveSshAiVaultSessionList,
  requestActiveSshAiVaultSessionTitles: mocks.requestActiveSshAiVaultSessionTitles
}))

const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-27T00:00:00.000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanAiVaultSessionsInWorker.mockResolvedValue(EMPTY_RESULT)
  mocks.resolveAiVaultSessionTitlesInWorker.mockResolvedValue({ titles: [] })
  mocks.scanRemoteAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
  mocks.getSshFilesystemProvider.mockReturnValue({} as IFilesystemProvider)
  mocks.getActiveSshAiVaultHostInfo.mockReturnValue(hostInfo())
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([hostInfo()])
  mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(null)
  mocks.requestActiveSshAiVaultSessionTitles.mockResolvedValue(null)
})

describe('Agent Session History scan coalescing', () => {
  it.each([
    ['local', mocks.scanAiVaultSessionsInWorker],
    ['runtime:remote-server', mocks.scanRuntimeAiVaultSessions]
  ] as const)('coalesces %s scans while isolating caller cancellation', async (scope, scan) => {
    let resolveScan: ((result: AiVaultListResult) => void) | undefined
    scan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        })
    )
    registerRuntimeHost()
    const firstController = new AbortController()
    const first = _internals.listAiVaultSessions(
      { executionHostScope: scope },
      { signal: firstController.signal }
    )
    const second = _internals.listAiVaultSessions({ executionHostScope: scope })
    await vi.waitFor(() => expect(resolveScan).toBeDefined())

    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(scan).toHaveBeenCalledTimes(1)
    resolveScan?.(EMPTY_RESULT)
    await expect(second).resolves.toEqual(EMPTY_RESULT)
  })

  it('coalesces every all-host leg while isolating caller cancellation', async () => {
    let resolveRuntime: ((result: AiVaultListResult) => void) | undefined
    mocks.scanRuntimeAiVaultSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRuntime = resolve
        })
    )
    registerRuntimeHost()
    const controller = new AbortController()

    const first = _internals.listAiVaultSessions(
      { executionHostScope: 'all' },
      { signal: controller.signal }
    )
    const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = _internals.listAiVaultSessions({ executionHostScope: 'all' })
    await vi.waitFor(() => expect(resolveRuntime).toBeDefined())

    expect(mocks.scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(1)
    expect(mocks.scanRemoteAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(1)
    controller.abort()
    await firstRejection
    resolveRuntime?.(EMPTY_RESULT)
    await expect(second).resolves.toMatchObject({ sessions: [], issues: [] })
  })

  it('keeps a shared multi-window scan alive when one window cancels', async () => {
    let resolveRelay: ((result: AiVaultListResult) => void) | undefined
    mocks.requestActiveSshAiVaultSessionList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRelay = resolve
        })
    )
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')
    const cancel = ipcHandler('aiVault:cancelListSessions')
    const firstEvent = { sender: { id: 1 } }
    const secondEvent = { sender: { id: 2 } }
    const first = list(firstEvent, {
      executionHostScope: 'ssh:dev-box',
      requestToken: 'scan'
    }) as Promise<AiVaultListResult>
    const second = list(secondEvent, {
      executionHostScope: 'ssh:dev-box',
      requestToken: 'scan'
    }) as Promise<AiVaultListResult>
    await vi.waitFor(() => expect(resolveRelay).toBeDefined())

    cancel(firstEvent, { requestToken: 'scan' })

    // Electron logs every rejected handler, so a cancelled scan resolves instead.
    await expect(first).resolves.toMatchObject({ cancelled: true, sessions: [], issues: [] })
    expect(mocks.requestActiveSshAiVaultSessionList).toHaveBeenCalledTimes(1)
    resolveRelay?.(EMPTY_RESULT)
    await expect(second).resolves.toEqual(EMPTY_RESULT)
  })

  it('reports a real scan failure as a host issue rather than cancellation', async () => {
    mocks.requestActiveSshAiVaultSessionList.mockRejectedValue(new Error('relay socket closed'))
    mocks.scanRemoteAiVaultSessions.mockRejectedValue(new Error('relay socket closed'))
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')

    // SSH host legs convert unexpected throws into scan issues so an `all`
    // multi-host list still returns the other hosts' sessions.
    const result = await list(
      { sender: { id: 1 } },
      { executionHostScope: 'ssh:dev-box', requestToken: 'scan' }
    )
    expect(result).toMatchObject({
      sessions: [],
      issues: [expect.objectContaining({ message: 'relay socket closed', kind: 'host' })]
    })
    expect(result).not.toHaveProperty('cancelled')
  })

  it('reports a failed local scan as a host issue rather than rejecting', async () => {
    mocks.scanAiVaultSessionsInWorker.mockRejectedValue(new Error('transcript root is unreadable'))
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')

    // The local leg degrades like the SSH legs above: a rejection reaches the
    // renderer as a raw string painted over the list instead of an issue row.
    const result = await list(
      { sender: { id: 1 } },
      { executionHostScope: 'local', requestToken: 'scan' }
    )
    expect(result).toMatchObject({
      sessions: [],
      issues: [expect.objectContaining({ message: 'transcript root is unreadable', kind: 'host' })]
    })
    expect(result).not.toHaveProperty('cancelled')
  })

  it('re-joins a preempted same-scope caller onto the forced refresh', async () => {
    const signals: AbortSignal[] = []
    let resolveForced: ((result: AiVaultListResult) => void) | undefined
    mocks.requestActiveSshAiVaultSessionList.mockImplementation(
      (_targetId, _params, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return new Promise((resolve) => {
          if (signals.length === 1) {
            options.signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
          } else {
            resolveForced = resolve
          }
        })
      }
    )
    const first = _internals.listAiVaultSessions({ executionHostScope: 'ssh:dev-box' })
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    const forced = _internals.listAiVaultSessions({
      executionHostScope: 'ssh:dev-box',
      force: true
    })
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    expect(signals[0]?.aborted).toBe(true)
    resolveForced?.(EMPTY_RESULT)
    // Another window's Refresh must not surface as this caller's cancellation.
    await expect(Promise.all([first, forced])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
  })
})

function registerRuntimeHost(): void {
  registerAiVaultHandlers({
    getActiveRuntimeAiVaultHostInfos: () => [
      { environmentId: 'remote-server', executionHostId: 'runtime:remote-server' }
    ],
    scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
  })
}

function hostInfo() {
  return {
    targetId: 'dev-box',
    executionHostId: 'ssh:dev-box' as const,
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64')
  }
}

function ipcHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel)
  if (!registration) {
    throw new Error(`${channel} was not registered`)
  }
  return registration[1]
}
