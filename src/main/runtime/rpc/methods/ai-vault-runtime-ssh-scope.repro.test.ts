import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'

const {
  scanAiVaultSessionsInWorker,
  resolveAiVaultSessionTitlesInWorker,
  scanSshAiVaultSessions,
  getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionTitles
} = vi.hoisted(() => ({
  scanAiVaultSessionsInWorker: vi.fn(),
  resolveAiVaultSessionTitlesInWorker: vi.fn(),
  scanSshAiVaultSessions: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(),
  requestActiveSshAiVaultSessionTitles: vi.fn()
}))

vi.mock('../../../ai-vault/session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker,
  resolveAiVaultSessionTitlesInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
}))

vi.mock('../../../ai-vault/ssh-session-list', () => ({
  scanSshAiVaultSessions
}))

vi.mock('../../../ipc/ssh', () => ({
  getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionTitles
}))

import { AI_VAULT_METHODS } from './ai-vault'
import {
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from '../../../ai-vault/cached-session-list'
import { resetAiVaultHostLegCacheForTests } from '../../../ipc/ai-vault-host-leg-cache'

const SCANNED_AT = '2026-08-12T00:00:00.000Z'
const SSH_HOST_OWNED_BY_RUNTIME = 'ssh:hub-owned-host'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntimeLocalSession(): AiVaultSession {
  return {
    id: 'local:claude:sess-hub:/hub/home/.claude/projects/p/t.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'sess-hub',
    title: 'Session on the runtime host itself',
    cwd: '/hub/home/projects/p',
    branch: null,
    model: null,
    filePath: '/hub/home/.claude/projects/p/t.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume sess-hub',
    subagent: null
  }
}

function makeSshSession(): AiVaultSession {
  return {
    ...makeRuntimeLocalSession(),
    id: 'ssh:hub-owned-host:claude:sess-ssh:/remote/home/.claude/projects/p/t.jsonl',
    executionHostId: 'ssh:hub-owned-host',
    sessionId: 'sess-ssh',
    title: 'Session on an SSH host this runtime owns',
    cwd: '/remote/home/projects/p',
    filePath: '/remote/home/.claude/projects/p/t.jsonl',
    resumeCommand: 'claude --resume sess-ssh'
  }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'hub-runtime',
    listAiVaultSessions: (args?: Parameters<typeof listAiVaultSessions>[0]) =>
      listAiVaultSessions(args),
    resolveAiVaultSessionTitles: (requests: unknown[], signal?: AbortSignal) =>
      resolveAiVaultSessionTitlesInWorker(requests, signal)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

describe('a runtime can scan an SSH host that it owns', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetAiVaultHostLegCacheForTests()
    scanAiVaultSessionsInWorker.mockReset()
    scanAiVaultSessionsInWorker.mockResolvedValue({
      sessions: [makeRuntimeLocalSession()],
      issues: [],
      scannedAt: SCANNED_AT
    } satisfies AiVaultListResult)
    resolveAiVaultSessionTitlesInWorker.mockReset()
    resolveAiVaultSessionTitlesInWorker.mockResolvedValue({ titles: [] })
    scanSshAiVaultSessions.mockReset()
    scanSshAiVaultSessions.mockResolvedValue({
      sessions: [makeSshSession()],
      issues: [],
      scannedAt: SCANNED_AT
    } satisfies AiVaultListResult)
    getActiveSshAiVaultHostInfos.mockReset()
    getActiveSshAiVaultHostInfos.mockReturnValue([{ targetId: 'hub-owned-host' }])
    requestActiveSshAiVaultSessionTitles.mockReset()
    requestActiveSshAiVaultSessionTitles.mockResolvedValue({
      titles: [{ agent: 'claude', sessionId: 'sess-ssh', title: 'SSH title' }]
    })
  })

  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetAiVaultHostLegCacheForTests()
  })

  it('routes an SSH execution host to that host instead of rejecting it', async () => {
    const dispatcher = makeDispatcher()

    const scoped = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: SSH_HOST_OWNED_BY_RUNTIME
      })
    )) as { ok: boolean; result: AiVaultListResult }

    expect(scoped.ok).toBe(true)
    expect(scanAiVaultSessionsInWorker).not.toHaveBeenCalled()
    expect(scanSshAiVaultSessions).toHaveBeenCalledWith(
      'hub-owned-host',
      expect.objectContaining({ limit: 500 }),
      { timeoutMs: 20_000 }
    )
    expect(scoped.result.sessions.map((session) => session.executionHostId)).toEqual([
      'ssh:hub-owned-host'
    ])
  })

  it('cancels a named SSH scan when its RPC request aborts', async () => {
    let scanSignal: AbortSignal | undefined
    scanSshAiVaultSessions.mockImplementationOnce(
      (
        _targetId: string,
        _args: unknown,
        options: { signal?: AbortSignal }
      ): Promise<AiVaultListResult> =>
        new Promise((_resolve, reject) => {
          scanSignal = options.signal
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
    const dispatcher = makeDispatcher()
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { executionHostId: SSH_HOST_OWNED_BY_RUNTIME }),
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(scanSignal).toBeDefined())

    controller.abort()

    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(scanSignal?.aborted).toBe(true)
  })

  it('scans the identical host-local sources for the runtime ids it does accept', async () => {
    const dispatcher = makeDispatcher()

    await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    const baselineScanArgs = scanAiVaultSessionsInWorker.mock.calls[0]?.[0]

    resetAiVaultSessionListCacheForTests()
    const scoped = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: 'runtime:some-other-env'
      })
    )) as { ok: boolean; result: AiVaultListResult }
    const scopedScanArgs = scanAiVaultSessionsInWorker.mock.calls[1]?.[0]

    expect(scoped.ok).toBe(true)
    expect(scopedScanArgs).toEqual(baselineScanArgs)
    expect(scanSshAiVaultSessions).not.toHaveBeenCalled()
    expect(scoped.result.sessions.map((session) => session.filePath)).toEqual([
      '/hub/home/.claude/projects/p/t.jsonl'
    ])
  })

  it('keeps unscoped scans host-local so old clients do not receive SSH rows', async () => {
    const dispatcher = makeDispatcher()

    const unscoped = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 500 })
    )) as { ok: boolean; result: AiVaultListResult }

    expect(unscoped.ok).toBe(true)
    expect(scanSshAiVaultSessions).not.toHaveBeenCalled()
    expect(unscoped.result.sessions.map((session) => session.executionHostId)).toEqual(['local'])
  })

  it('merges this runtime’s connected SSH hosts only when the caller opts in', async () => {
    const dispatcher = makeDispatcher()

    const optedIn = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: 'runtime:hub-runtime',
        includeOwnedSshHosts: true
      })
    )) as { ok: boolean; result: AiVaultListResult }

    expect(optedIn.ok).toBe(true)
    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(1)
    expect(scanSshAiVaultSessions).toHaveBeenCalledWith(
      'hub-owned-host',
      expect.objectContaining({ limit: 500 }),
      { timeoutMs: 20_000 }
    )
    expect(optedIn.result.sessions.map((session) => session.executionHostId).sort()).toEqual([
      'runtime:hub-runtime',
      'ssh:hub-owned-host'
    ])
  })

  it('keeps healthy SSH results when the runtime-local scan throws', async () => {
    scanAiVaultSessionsInWorker.mockRejectedValue(new Error('WSL home resolution failed'))
    const dispatcher = makeDispatcher()

    const response = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        executionHostId: 'runtime:hub-runtime',
        includeOwnedSshHosts: true
      })
    )) as { ok: boolean; result: AiVaultListResult }

    expect(response.ok).toBe(true)
    expect(response.result.sessions).toEqual([
      expect.objectContaining({ executionHostId: 'ssh:hub-owned-host' })
    ])
    expect(response.result.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'runtime:hub-runtime',
        kind: 'host',
        message: 'WSL home resolution failed'
      })
    ])
  })

  it('observes an owned SSH cancellation while the local scan is pending', async () => {
    let resolveLocal!: (result: AiVaultListResult) => void
    let scanSignal: AbortSignal | undefined
    scanAiVaultSessionsInWorker.mockReturnValueOnce(
      new Promise<AiVaultListResult>((resolve) => {
        resolveLocal = resolve
      })
    )
    scanSshAiVaultSessions.mockImplementationOnce(
      (
        _targetId: string,
        _args: unknown,
        options: { signal?: AbortSignal }
      ): Promise<AiVaultListResult> =>
        new Promise((_resolve, reject) => {
          scanSignal = options.signal
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
    const dispatcher = makeDispatcher()
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        executionHostId: 'runtime:hub-runtime',
        includeOwnedSshHosts: true
      }),
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(scanSignal).toBeDefined())

    controller.abort()
    const settled = await Promise.race([
      pending,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending')))
    ])
    resolveLocal({ sessions: [], issues: [], scannedAt: SCANNED_AT })

    expect(settled).toMatchObject({ ok: false })
  })

  it('reuses each SSH host leg across repeated non-force all-host scans', async () => {
    const dispatcher = makeDispatcher()
    const params = {
      limit: 500,
      executionHostId: 'runtime:hub-runtime',
      includeOwnedSshHosts: true
    }

    await dispatcher.dispatch(makeRequest('aiVault.listSessions', params))
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', params))

    expect(scanSshAiVaultSessions).toHaveBeenCalledTimes(1)
  })

  it('bypasses the SSH host-leg cache for a forced refresh', async () => {
    const dispatcher = makeDispatcher()
    const params = {
      limit: 500,
      force: true,
      executionHostId: 'runtime:hub-runtime',
      includeOwnedSshHosts: true
    }

    await dispatcher.dispatch(makeRequest('aiVault.listSessions', params))
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', params))

    expect(scanSshAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it('resolves SSH session titles on the transcript-owning host', async () => {
    const dispatcher = makeDispatcher()
    const requests = [{ agent: 'claude', sessionId: 'sess-ssh' }]

    const response = await dispatcher.dispatch(
      makeRequest('aiVault.resolveSessionTitles', {
        requests,
        executionHostId: SSH_HOST_OWNED_BY_RUNTIME
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { titles: [{ sessionId: 'sess-ssh', title: 'SSH title' }] }
    })
    expect(requestActiveSshAiVaultSessionTitles).toHaveBeenCalledWith(
      'hub-owned-host',
      { requests },
      expect.objectContaining({ signal: undefined })
    )
    expect(resolveAiVaultSessionTitlesInWorker).not.toHaveBeenCalled()
  })
})
