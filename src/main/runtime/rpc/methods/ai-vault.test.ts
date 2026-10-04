import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultServiceScanOptions } from '../../../ai-vault/session-scanner-service-protocol'
import {
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'

const { scanAiVaultSessionsInService, resolveAiVaultSessionTitlesInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService:
    vi.fn<
      (options: AiVaultServiceScanOptions, signal?: AbortSignal) => Promise<AiVaultListResult>
    >(),
  resolveAiVaultSessionTitlesInService: vi.fn()
}))

vi.mock('../../../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService,
  resolveAiVaultSessionTitlesInService
}))

import {
  AI_VAULT_METHODS,
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams
} from './ai-vault'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { recordStructuredAgentSessionHostInstallRefusal } from '../../structured-agent-session-host-refusal'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from '../../../ai-vault/cached-session-list'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const SCANNED_AT = '2026-06-29T00:00:00.000Z'

function makeResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: SCANNED_AT }
}

function makeSession(): AiVaultSession {
  return {
    id: 'local:claude:sess-1:/tmp/t.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'sess-1',
    title: 'Test session',
    cwd: '/tmp',
    branch: null,
    model: null,
    filePath: '/tmp/t.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume sess-1',
    subagent: null
  }
}

function makeDispatcher(): RpcDispatcher {
  // Why: the handler only needs getRuntimeId (envelope) + listAiVaultSessions,
  // which delegates to the shared cache module the IPC handler also uses.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only these three runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    listAiVaultSessions: (args?: Parameters<typeof listAiVaultSessions>[0]) =>
      listAiVaultSessions(args),
    resolveAiVaultSessionTitles: (requests: unknown[], signal?: AbortSignal) =>
      resolveAiVaultSessionTitlesInService(requests, signal)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

function makeFailingDispatcher(error: Error): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    listAiVaultSessions: vi.fn().mockRejectedValue(error)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

describe('aiVault.resolveSessionTitles handler', () => {
  beforeEach(() => {
    resolveAiVaultSessionTitlesInService.mockReset()
  })

  it('advertises and routes the bounded exact-title capability', async () => {
    resolveAiVaultSessionTitlesInService.mockResolvedValue({
      titles: [{ agent: 'codex', sessionId: 'session-1', title: 'Exact title' }]
    })
    const dispatcher = makeDispatcher()
    const requests = [
      { agent: 'codex', sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl' }
    ]

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }))
    ).resolves.toMatchObject({
      ok: true,
      result: { titles: [{ sessionId: 'session-1', title: 'Exact title' }] }
    })
    expect(resolveAiVaultSessionTitlesInService).toHaveBeenCalledWith(requests, undefined)
    expect(RUNTIME_CAPABILITIES).toContain(AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY)
  })

  it('forwards transport cancellation to the background scanner', async () => {
    resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
    const dispatcher = makeDispatcher()
    const controller = new AbortController()
    const requests = [{ agent: 'codex', sessionId: 'session-1' }]

    await dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }), {
      signal: controller.signal
    })

    expect(resolveAiVaultSessionTitlesInService).toHaveBeenCalledWith(requests, controller.signal)
  })

  it('rejects more than 64 title identities before reaching the host', async () => {
    const dispatcher = makeDispatcher()
    const requests = Array.from({ length: 65 }, (_, index) => ({
      agent: 'codex',
      sessionId: `session-${index}`
    }))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.resolveSessionTitles', { requests }))
    ).resolves.toMatchObject({ ok: false })
    expect(resolveAiVaultSessionTitlesInService).not.toHaveBeenCalled()
  })
})

describe('aiVault.listSessions params schema', () => {
  it('accepts a bounded request', () => {
    const parsed = AiVaultListSessionsParams.safeParse({
      limit: 500,
      force: true,
      scopePaths: ['/home/user/repo']
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a limit above the cap', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ limit: 5000 })
    expect(parsed.success).toBe(false)
  })

  it('accepts Unlimited without applying the numeric cap', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ limit: 5000, unlimited: true })
    expect(parsed.success).toBe(true)
  })

  it('clamps scopePaths past the cap instead of rejecting', () => {
    // Why: uncapped producers (web client, pre-cap desktop parents) may exceed
    // the bound; scope paths only widen discovery, so truncation is safe.
    const scopePaths = Array.from({ length: 65 }, (_, index) => `/p/${index}`)
    const parsed = AiVaultListSessionsParams.safeParse({ scopePaths })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.scopePaths).toEqual(scopePaths.slice(0, 64))
  })

  it('rejects an over-long scopePath', () => {
    const parsed = AiVaultListSessionsParams.safeParse({ scopePaths: ['/'.padEnd(5000, 'a')] })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-runtime execution host ids before dispatch', () => {
    expect(
      AiVaultListSessionsParams.safeParse({ executionHostId: 'not-a-runtime-host' }).success
    ).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ executionHostId: 'local' }).success).toBe(false)
    expect(AiVaultListSessionsParams.safeParse({ executionHostId: 'ssh:dev-box' }).success).toBe(
      false
    )
  })
})

describe('aiVault.prepareSessionResume', () => {
  it('validates bounded paths and executes against the receiving host identity', async () => {
    expect(
      AiVaultPrepareSessionResumeParams.safeParse({
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed'
      }).success
    ).toBe(true)
    const prepareAiVaultSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'ssh:spoofed'
      })
    )

    expect(response).toMatchObject({ ok: true, result: { useRealCodexHome: true } })
    expect(prepareAiVaultSessionResume).toHaveBeenCalledWith({
      agent: 'codex',
      filePath: '/managed/sessions/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'local'
    })
  })
})

// Session history and terminal resume are not chats: a process whose chats are refused still
// serves them, while any other host failure still fails the request.
describe('aiVault methods without a structured host', () => {
  const refusal = agentSessionRefusalError(
    'agent_session_journal_unreadable',
    { reason: 'journalCorrupt' },
    'Unable to load this chat.'
  )

  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockReset()
    scanAiVaultSessionsInService.mockResolvedValue(makeResult())
    recordStructuredAgentSessionHostInstallRefusal(refusal)
  })

  afterEach(() => {
    recordStructuredAgentSessionHostInstallRefusal(null)
    resetAiVaultSessionListCacheForTests()
  })

  function refusedDispatcher(installError: Error): RpcDispatcher {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two aiVault handlers read only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn().mockRejectedValue(installError),
      listAiVaultSessions: (args?: Parameters<typeof listAiVaultSessions>[0]) =>
        listAiVaultSessions(args),
      prepareAiVaultSessionResume: vi.fn().mockResolvedValue({ useRealCodexHome: true })
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
  }

  it('lists and prepares a resume while chats are refused', async () => {
    const dispatcher = refusedDispatcher(refusal)

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({ ok: true, result: makeResult() })
    await expect(
      dispatcher.dispatch(
        makeRequest('aiVault.prepareSessionResume', {
          agent: 'codex',
          filePath: '/managed/sessions/rollout-a.jsonl',
          codexHome: '/managed'
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { useRealCodexHome: true } })
  })

  it('still fails on a host error that refuses nothing', async () => {
    const dispatcher = refusedDispatcher(new Error('the record store would not open'))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({ ok: false })
  })
})

describe('aiVault.listSessions handler + shared cache', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockReset()
    scanAiVaultSessionsInService.mockResolvedValue(makeResult())
    resolveAiVaultSessionTitlesInService.mockReset()
    resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  })

  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
  })

  it('isolates IDE opt-in scans from legacy clients sharing the host cache', async () => {
    const dispatcher = makeDispatcher()
    await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { includeAntigravityIdeSessions: true })
    )
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      includeAntigravityIdeSessions: true
    })
    expect(scanAiVaultSessionsInService.mock.calls[1]?.[0]?.includeAntigravityIdeSessions).not.toBe(
      true
    )
  })

  it('returns the AiVaultListResult unchanged', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    expect(response).toMatchObject({ ok: true, result: makeResult() })
  })

  it('humanizes scanner supervision errors for remote clients', async () => {
    const dispatcher = makeFailingDispatcher(new Error('AI Vault service restart circuit is open.'))

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'Session scanning paused after repeated failures. Refresh to try again.' }
    })
  })

  it('preserves structured runtime error metadata while humanizing its message', async () => {
    const error = Object.assign(new Error('AI Vault service restart circuit is open.'), {
      code: 'runtime_timeout',
      data: { retryAfterMs: 5000 }
    })
    const dispatcher = makeFailingDispatcher(error)

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'runtime_timeout',
        message: 'Session scanning paused after repeated failures. Refresh to try again.',
        data: { retryAfterMs: 5000 }
      }
    })
  })

  it('passes only the first 64 scopePaths to the scanner when a request exceeds the cap', async () => {
    const dispatcher = makeDispatcher()
    const scopePaths = Array.from({ length: 65 }, (_, index) => `/p/${index}`)
    const response = await dispatcher.dispatch(makeRequest('aiVault.listSessions', { scopePaths }))
    expect(response).toMatchObject({ ok: true })
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      scopePaths: scopePaths.slice(0, 64)
    })
  })

  it('shares one cache between the IPC entry point and the RPC method', async () => {
    const dispatcher = makeDispatcher()
    // First call via the shared module (what the desktop IPC handler invokes).
    await listAiVaultSessions({ limit: 500 })
    // Second call via the RPC method with the same cache key.
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('keeps completed scans cached for one minute', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-05T00:00:00.000Z') })
    try {
      await listAiVaultSessions({ limit: 500 })
      await vi.advanceTimersByTimeAsync(59_999)
      await listAiVaultSessions({ limit: 500 })
      expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await listAiVaultSessions({ limit: 500 })
      expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves lower depths from a larger completed scan', async () => {
    await listAiVaultSessions({ limit: 1000 })
    await listAiVaultSessions({ limit: 250 })
    await listAiVaultSessions({ limit: 500 })

    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('shares a cache entry across equivalent scope path ordering', async () => {
    await listAiVaultSessions({ limit: 500, scopePaths: ['/repo/a', '/repo/b'] })
    await listAiVaultSessions({ limit: 500, scopePaths: ['/repo/b', '/repo/a'] })

    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
  })

  it('forwards Unlimited without a numeric limit', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 5000, unlimited: true })
    )

    expect(response).toMatchObject({ ok: true })
    expect(scanAiVaultSessionsInService).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined, unlimited: true }),
      expect.any(AbortSignal)
    )
  })

  it('keeps a newer different-key scan dedupable after an older scan resolves', async () => {
    // Why: the resolving scan's cleanup must not clear tracking a concurrent
    // different-key scan replaced, or re-requests start a duplicate rescan.
    const deferreds: ((result: AiVaultListResult) => void)[] = []
    scanAiVaultSessionsInService.mockImplementation(
      () => new Promise<AiVaultListResult>((resolve) => deferreds.push(resolve))
    )
    // The scanner is invoked a microtask after the call (WSL-home await), so
    // wait for each deferred to register before driving resolution order.
    const scanA = listAiVaultSessions({ limit: 100 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(1))
    const scanB = listAiVaultSessions({ limit: 200 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(2))
    deferreds[0]?.(makeResult())
    await scanA
    // Re-request key B while its first scan is still pending: must dedupe.
    const scanBAgain = listAiVaultSessions({ limit: 200 })
    // Flush a macrotask so that a wrongly-started duplicate scan would reach the
    // mock (it fires a microtask after the WSL-home await): guarded stays 2, a
    // reverted guard reads 3, so this assertion — not a Promise.all hang — pins
    // the fix.
    await new Promise((resolve) => setTimeout(resolve))
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    deferreds[1]?.(makeResult())
    await Promise.all([scanB, scanBAgain])
  })

  it('restamps the shared cached result as the addressed runtime host', async () => {
    scanAiVaultSessionsInService.mockResolvedValue({
      sessions: [makeSession()],
      issues: [{ executionHostId: 'local', agent: 'claude', path: '/tmp', message: 'boom' }],
      scannedAt: SCANNED_AT
    })
    const dispatcher = makeDispatcher()
    // A mobile-style caller (no executionHostId) primes the shared cache…
    const localResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 500 })
    )) as { ok: boolean; result: AiVaultListResult }
    // …then a desktop/web caller addressing this host by runtime id reuses it.
    const runtimeResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: 'runtime:remote-server'
      })
    )) as { ok: boolean; result: AiVaultListResult }

    // Why: the host id must never change what is scanned — one host-local scan
    // (and one cache entry) serves every caller; only the stamps differ.
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      executionHostId: 'local'
    })

    expect(localResponse.result.sessions[0]?.executionHostId).toBe('local')
    expect(runtimeResponse.result.sessions[0]?.executionHostId).toBe('runtime:remote-server')
    expect(runtimeResponse.result.sessions[0]?.id).toBe(
      'runtime:remote-server:claude:sess-1:/tmp/t.jsonl'
    )
    expect(runtimeResponse.result.issues[0]?.executionHostId).toBe('runtime:remote-server')
  })

  it('injects codex-home dirs sourced from the runtime (serve-mode reachable)', async () => {
    configureAiVaultSessionSources({
      getAdditionalCodexHomePaths: () => ['/runtime/codex/home']
    })
    const dispatcher = makeDispatcher()
    await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    const options = scanAiVaultSessionsInService.mock.calls[0]?.[0]
    // Why: the codex-home is sourced from the runtime, not the window-only
    // registerCoreHandlers path, so it survives in serve mode.
    expect(options?.additionalCodexSessionsDirs).toContain('/runtime/codex/home/sessions')
    expect(options?.wslHomeDirs).toEqual([])
  })

  it('forwards codex-home through the real OrcaRuntimeService construction path', async () => {
    // Why: the dispatcher test above seeds the cache module directly, so it would
    // still pass if OrcaRuntimeService stopped forwarding the codex-home source.
    // Construct the real runtime to lock that cross-layer wiring in place.
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAdditionalAiVaultCodexHomePaths: () => ['/ctor/codex/home']
    })
    await runtime.listAiVaultSessions({})
    const options = scanAiVaultSessionsInService.mock.calls[0]?.[0]
    expect(options?.additionalCodexSessionsDirs).toContain('/ctor/codex/home/sessions')
  })
})
