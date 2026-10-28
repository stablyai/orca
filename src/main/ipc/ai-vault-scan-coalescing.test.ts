import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  ipcHandle: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanAiVaultSessionsInService,
  resolveAiVaultSessionTitlesInService: mocks.resolveAiVaultSessionTitlesInService
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_path: string, id: string) => ({
    id,
    runtimeId: id,
    pairingRevision: 1,
    createdAt: 1
  })
}))
import { createAiVaultAssociationObserver } from './ai-vault-projection-dependency'
import { invalidateAiVaultHostLegCache } from './ai-vault-host-leg-cache'
import { registerRuntimeEnvironmentSubscriptionHandlers } from './runtime-environments/runtime-environment-subscription-handlers'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environments/runtime-environment-transport-generation'
import type { subscribeRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
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
  mocks.scanAiVaultSessionsInService.mockResolvedValue(EMPTY_RESULT)
  mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
})

describe('Agent Session History scan coalescing', () => {
  it('never shares a compact reply with a caller missing its exact baseline', async () => {
    registerRuntimeHost()
    const fingerprint = 'a'.repeat(64)
    mocks.scanRuntimeAiVaultSessions.mockImplementation(async (_host, args) => {
      await Promise.resolve()
      return args.afterFingerprint === fingerprint
        ? { ...EMPTY_RESULT, fingerprint, unchanged: true }
        : { ...EMPTY_RESULT, scannedAt: 'full' }
    })
    const [conditional, legacy] = await Promise.all([
      _internals.listAiVaultSessions({
        executionHostScope: 'runtime:remote-server',
        afterFingerprint: fingerprint
      }),
      _internals.listAiVaultSessions({ executionHostScope: 'runtime:remote-server' })
    ])
    expect(conditional.unchanged).toBe(true)
    expect(legacy.unchanged).toBeUndefined()
    expect(legacy.scannedAt).toBe('full')
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it('does not forward conditional hints into truncated all-host merges', async () => {
    registerRuntimeHost()
    await _internals.listAiVaultSessions({
      executionHostScope: 'all',
      afterFingerprint: 'a'.repeat(64)
    })
    expect(mocks.scanRuntimeAiVaultSessions.mock.calls[0]?.[1]).not.toHaveProperty(
      'afterFingerprint'
    )
  })

  it.each([
    ['local', mocks.scanAiVaultSessionsInService],
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
    await expect(second).resolves.toMatchObject(EMPTY_RESULT)
  })

  it('reports a failed local scan as a host issue rather than rejecting', async () => {
    mocks.scanAiVaultSessionsInService.mockRejectedValue(new Error('transcript root is unreadable'))
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')

    // Like SSH failures, local failures must become issue rows instead of rejected IPC calls.
    const result = await list(
      { sender: Object.assign(new EventEmitter(), { id: 1 }) },
      { executionHostScope: 'local', requestToken: 'scan' }
    )
    expect(result).toMatchObject({
      sessions: [],
      scanId: expect.any(String),
      issues: [expect.objectContaining({ message: 'transcript root is unreadable', kind: 'host' })]
    })
    expect(result).not.toHaveProperty('cancelled')
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

function ipcHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel)
  if (!registration) {
    throw new Error(`${channel} was not registered`)
  }
  return registration[1]
}

afterEach(() => {
  _internals.resetAiVaultCacheForTests()
  vi.useRealTimers()
})

it('orders forwarded association edges before new remote/All admissions and fences other-window work', async () => {
  vi.useFakeTimers()
  const retained = new Map()
  const pending = new Map()
  const forwarding: (() => Promise<AiVaultListResult>)[] = []
  const sender = Object.assign(new EventEmitter(), {
    id: 91,
    isDestroyed: () => false,
    send: vi.fn(() => {
      forwarding.push(() => list('runtime:a'))
    })
  })
  let callbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  mocks.subscribe.mockImplementation(
    async (...args: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = args[5]
      return { requestId: 'status', sendBinary: () => true, close: () => {} }
    }
  )
  let observerThrows = false
  const recordLayoutFrame = vi.fn()
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/profile',
    remoteRuntimeSubscriptions: retained,
    pendingSubscriptions: pending,
    createAssociationObserver: (host, identity) => {
      const observer = createAiVaultAssociationObserver(
        host,
        identity,
        invalidateAiVaultHostLegCache
      )
      return {
        ...observer,
        observe: (frame) => {
          if (observerThrows) {
            throw new Error('observer')
          }
          observer.observe(frame)
        }
      }
    },
    recordLayoutFrame
  })
  registerAiVaultHandlers({
    getUserDataPath: () => '/profile',
    getActiveRuntimeAiVaultHostInfos: () => [
      { environmentId: 'a', executionHostId: 'runtime:a' },
      { environmentId: 'b', executionHostId: 'runtime:b' }
    ],
    scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
  })
  const list = (executionHostScope: 'runtime:a' | 'runtime:b' | 'all', scopePaths: string[] = []) =>
    _internals.listAiVaultSessions({ executionHostScope, scopePaths, limit: 250 })
  await ipcHandler('runtimeEnvironments:subscribe')(
    { sender },
    { selector: 'a', method: 'agentSession.subscribeStatus', subscriptionId: 'association' }
  )
  const summary = {
    sessionId: 'native',
    workspaceId: 'workspace',
    agent: 'pi',
    providerSession: { key: 'session_id', id: '/old-provider' }
  }
  const frame = (result: unknown) =>
    callbacks?.onEvent({
      type: 'response',
      response: { id: 'status', ok: true, result, _meta: { runtimeId: 'a' } }
    })
  frame({ type: 'snapshot', sessions: [summary] })
  forwarding.length = 0
  let detached = false
  const answer = (host: string): AiVaultListResult => ({
    ...EMPTY_RESULT,
    fingerprint: detached ? 'detached' : 'owned',
    sessions: [
      {
        id: `runtime:${host}:codex:host-session:/host/transcript.jsonl`,
        executionHostId: `runtime:${host}`,
        agent: 'codex',
        sessionId: 'host-session',
        cwd: '/host/folder',
        branch: null,
        model: null,
        filePath: '/host/transcript.jsonl',
        codexHome: '/host/codex',
        createdAt: null,
        updatedAt: null,
        modifiedAt: '',
        messageCount: 2,
        totalTokens: 0,
        previewMessages: [],
        queuedMessageCount: 0,
        subagentTranscriptCount: 0,
        resumeCommand: 'host-resume-command',
        subagent: null,
        title: detached ? 'Provider title' : 'Manual name',
        ...(detached
          ? {}
          : { structuredSession: { sessionId: 'native', workspaceId: 'workspace' } })
      }
    ]
  })
  mocks.scanRuntimeAiVaultSessions.mockImplementation(async (host) => answer(host))
  await list('runtime:a')
  await list('runtime:b')
  await list('all')
  const baseline = mocks.scanRuntimeAiVaultSessions.mock.calls.length
  for (const n of [10, 100]) {
    for (let i = 0; i < n; i++) {
      frame({ type: 'status', session: { ...summary, updatedAt: i, conversationName: `${i}` } })
      frame({ type: 'snapshot', sessions: [], namingActiveSessionIds: [], conversationNames: [] })
      frame({ type: 'snapshot', sessions: [] })
    }
    await list('runtime:a')
    await list('runtime:b')
    await list('all')
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(baseline)
  }
  const held: (() => void)[] = []
  mocks.scanRuntimeAiVaultSessions.mockImplementation((host, args) => {
    const result = answer(host)
    return args.scopePaths?.includes('/race') && !detached
      ? new Promise((resolve) => held.push(() => resolve(result)))
      : Promise.resolve(result)
  })
  const oldA = list('runtime:a', ['/race'])
  const oldAll = list('all', ['/race'])
  const oldB = list('runtime:b', ['/race'])
  await vi.waitFor(() => expect(held).toHaveLength(4))
  const warmRaceScannerStarts = mocks.scanAiVaultSessionsInService.mock.calls.length
  forwarding.length = 0
  detached = true
  frame({ type: 'status', session: { ...summary, providerSession: undefined } })
  // invoke admits these after the forwarding callback has returned, as Electron does.
  expect((await forwarding[0]!()).sessions[0]?.structuredSession).toBeUndefined()
  const currentA = await list('runtime:a', ['/race'])
  const currentAll = await list('all', ['/race'])
  expect(currentA.sessions[0]?.title).toBe('Provider title')
  expect(currentAll.sessions.every((row) => row.structuredSession === undefined)).toBe(true)
  const bCalls = mocks.scanRuntimeAiVaultSessions.mock.calls.filter(([host]) => host === 'b').length
  const bWaiter = list('runtime:b', ['/race'])
  held.forEach((finish) => finish())
  await Promise.all([oldA, oldAll, oldB, bWaiter])
  expect(mocks.scanRuntimeAiVaultSessions.mock.calls.filter(([host]) => host === 'b')).toHaveLength(
    bCalls
  )
  expect((await list('runtime:b', ['/race'])).sessions[0]?.title).toBe('Manual name')
  expect((await list('runtime:a', ['/race'])).sessions[0]?.title).toBe('Provider title')
  expect((await list('all', ['/race'])).sessions).toEqual(currentAll.sessions)
  // Expired projected caches must not resurrect the pre-edge last-full answer.
  await vi.advanceTimersByTimeAsync(15_000)
  mocks.scanRuntimeAiVaultSessions.mockResolvedValueOnce({
    ...EMPTY_RESULT,
    fingerprint: 'owned',
    unchanged: true
  })
  expect((await list('runtime:a')).sessions).toEqual([])
  expect(mocks.scanAiVaultSessionsInService).toHaveBeenCalledTimes(warmRaceScannerStarts)
  expect(mocks.scanRuntimeAiVaultSessions.mock.calls.every(([, args]) => args.force !== true)).toBe(
    true
  )
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  observerThrows = true
  frame({ type: 'snapshot', sessions: [] })
  expect(warning).toHaveBeenCalled()
  await forwarding.at(-1)!()
  warning.mockRestore()
  const sends = sender.send.mock.calls.length
  advanceRuntimeEnvironmentTransportGeneration('a')
  frame({ type: 'snapshot', sessions: [] })
  expect(sender.send).toHaveBeenCalledTimes(sends)
  await ipcHandler('runtimeEnvironments:unsubscribe')({ sender }, { subscriptionId: 'association' })
  expect(retained.size).toBe(0)
  await ipcHandler('runtimeEnvironments:subscribe')(
    { sender },
    { selector: 'a', method: 'agentSession.subscribeStatus', subscriptionId: 'renewed' }
  )
  observerThrows = false
  await list('runtime:a')
  frame({ type: 'status', session: { ...summary, providerSession: undefined } })
  await list('runtime:a')
  const beforeRenewal = mocks.scanRuntimeAiVaultSessions.mock.calls.length
  frame({ type: 'snapshot', sessions: [] })
  await list('runtime:a')
  expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(beforeRenewal + 1)
  await ipcHandler('runtimeEnvironments:unsubscribe')({ sender }, { subscriptionId: 'renewed' })
  const disposedSends = sender.send.mock.calls.length
  frame({ type: 'status', session: summary })
  expect(sender.send).toHaveBeenCalledTimes(disposedSends)
  expect(retained.size).toBe(0)
})
