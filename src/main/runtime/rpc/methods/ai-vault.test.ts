import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeAiVaultCommands } from '../../runtime-ai-vault-commands'
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
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  installCopyingChat,
  installOwnership
} from '../../../ai-vault/structured-session-ownership.test-support'
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
  // Exercise the same shared vault cache used by desktop IPC.
  const vault = new RuntimeAiVaultCommands(() => null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only these three runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    getExistingOrchestrationDb: () => null,
    listAiVaultSessions: vault.list.bind(vault),
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
    // Older/web producers may exceed this bound; truncation only narrows optional discovery paths.
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

  it('carries a fork request through to the host preparation', async () => {
    const prepareAiVaultSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'codex',
        filePath: '/managed/sessions/rollout-a.jsonl',
        codexHome: '/managed',
        fork: true
      })
    )

    expect(prepareAiVaultSessionResume).toHaveBeenCalledWith(
      expect.objectContaining({ fork: true, executionHostId: 'local' })
    )
  })
})

describe('aiVault.prepareSessionResume for a chat whose host makes the copy', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it("has the server's chat copy an OMP conversation and answers the copy", async () => {
    const providerSessionId = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
    const copy = vi.fn(async () => ({
      sessionId: 'copy-1',
      filePath: '/sessions/copy-1.jsonl'
    }))
    installCopyingChat({ transport: 'acp', agent: 'omp', nativeId: providerSessionId }, copy)
    const prepareAiVaultSessionResume = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      prepareAiVaultSessionResume
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('aiVault.prepareSessionResume', {
        agent: 'omp',
        sessionId: providerSessionId,
        filePath: `/home/me/.omp/agent/sessions/--repo--/x_${providerSessionId}.jsonl`,
        codexHome: null,
        fork: true
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        useRealCodexHome: false,
        forkedSession: {
          sessionId: 'copy-1',
          filePath: '/sessions/copy-1.jsonl',
          agent: 'omp'
        }
      }
    })
    expect(copy).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId }))
    expect(prepareAiVaultSessionResume).not.toHaveBeenCalled()
  })
})

// Chat-host refusal must not disable transcript history or terminal resume; other host failures still propagate.
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
      listAiVaultSessions: (
        args?: Parameters<typeof listAiVaultSessions>[0],
        signal?: AbortSignal
      ) => listAiVaultSessions(args, { signal }),
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

  it.each([undefined, 'runtime:test-runtime'] as const)(
    'includes retained records only on opt-in with catalog coverage for %s',
    async (executionHostId) => {
      const dispatcher = makeDispatcher()
      installOwnership({ conversationName: 'Retained conversation' })
      try {
        await expect(
          dispatcher.dispatch(
            makeRequest('aiVault.listSessions', {
              includeStructuredSessions: true,
              executionHostId
            })
          )
        ).resolves.toMatchObject({
          ok: true,
          result: {
            includesStructuredSessions: true,
            sessions: [
              expect.objectContaining({
                source: 'structured-record',
                title: 'Retained conversation',
                structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
              })
            ]
          }
        })
        const transcriptOnly = await dispatcher.dispatch(
          makeRequest('aiVault.listSessions', { executionHostId })
        )
        expect(transcriptOnly).toMatchObject({ ok: true, result: { sessions: [] } })
        if (transcriptOnly.ok) {
          expect(transcriptOnly.result).not.toHaveProperty('includesStructuredSessions')
        }
        setStructuredAgentSessionHost(null)
        const unsupported = await dispatcher.dispatch(
          makeRequest('aiVault.listSessions', { includeStructuredSessions: true, executionHostId })
        )
        expect(unsupported.ok).toBe(true)
        if (unsupported.ok) {
          expect(unsupported.result).not.toHaveProperty('includesStructuredSessions')
        }
      } finally {
        setStructuredAgentSessionHost(null)
      }
    }
  )

  it.each([undefined, 'runtime:test-runtime'] as const)(
    'keeps a selected record after 500 newer rows and separates its cache (%s)',
    async (executionHostId) => {
      const selected = {
        ...makeSession(),
        id: 'local:claude:old:/old.jsonl',
        sessionId: 'old',
        filePath: '/old.jsonl'
      }
      const recent = Array.from({ length: 501 }, (_, index) => ({
        ...makeSession(),
        id: `local:claude:new-${index}:/new-${index}.jsonl`,
        sessionId: `new-${index}`,
        filePath: `/new-${index}.jsonl`
      }))
      scanAiVaultSessionsInService.mockResolvedValue({
        ...makeResult(),
        sessions: [...recent, selected]
      })
      const dispatcher = makeDispatcher()
      const selectedSessionId = executionHostId
        ? selected.id.replace('local:', `${executionHostId}:`)
        : selected.id
      const response = await dispatcher.dispatch(
        makeRequest('aiVault.listSessions', {
          limit: 500,
          includeStructuredSessions: true,
          selectedSessionId,
          executionHostId
        })
      )
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.result).toMatchObject({
          sessions: expect.arrayContaining([expect.objectContaining({ id: selectedSessionId })])
        })
        expect(response.result).toHaveProperty('sessions.length', 501)
      }
      expect(scanAiVaultSessionsInService.mock.calls.at(-1)?.[0]).toMatchObject({
        selectedSessionId: selected.id,
        limit: 500
      })
      await dispatcher.dispatch(makeRequest('aiVault.listSessions', { limit: 500 }))
      expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
    }
  )

  it('aborts the host scan when its last RPC caller disconnects', async () => {
    scanAiVaultSessionsInService.mockImplementation(
      (_options, signal) =>
        new Promise<AiVaultListResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('scan aborted')), { once: true })
        })
    )
    const dispatcher = makeDispatcher()
    const caller = new AbortController()
    const response = dispatcher.dispatch(makeRequest('aiVault.listSessions', {}), {
      signal: caller.signal
    })
    await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledOnce())
    const scanSignal = scanAiVaultSessionsInService.mock.calls[0]?.[1]

    caller.abort()

    expect(scanSignal?.aborted).toBe(true)
    await expect(response).resolves.toMatchObject({ ok: false })
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

  it('omits unchanged session bodies only for clients with the matching fingerprint', async () => {
    const dispatcher = makeDispatcher()
    const first = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { afterFingerprint: null })
    )
    if (
      !first.ok ||
      typeof first.result !== 'object' ||
      first.result === null ||
      !('fingerprint' in first.result) ||
      typeof first.result.fingerprint !== 'string'
    ) {
      throw new Error('Opt-in response did not include a fingerprint')
    }
    const afterFingerprint = first.result.fingerprint
    expect(afterFingerprint).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      dispatcher.dispatch(makeRequest('aiVault.listSessions', { afterFingerprint }))
    ).resolves.toMatchObject({
      ok: true,
      result: { unchanged: true, fingerprint: afterFingerprint }
    })
    const legacy = await dispatcher.dispatch(makeRequest('aiVault.listSessions', {}))
    expect(legacy).toMatchObject({ ok: true, result: makeResult() })
    if (legacy.ok) {
      expect(legacy.result).not.toHaveProperty('fingerprint')
    }
  })

  it('keeps unlimited history un-hashed and full even with an opt-in request', async () => {
    const dispatcher = makeDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        unlimited: true,
        afterFingerprint: null
      })
    )
    expect(response).toMatchObject({ ok: true, result: makeResult() })
    if (response.ok) {
      expect(response.result).not.toHaveProperty('fingerprint')
      expect(response.result).not.toHaveProperty('unchanged')
    }
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({ unlimited: true })
  })

  it('fingerprints live projected content even when the cached scan stamp does not change', async () => {
    const source = { ...makeResult(), sessions: [makeSession()] }
    scanAiVaultSessionsInService.mockResolvedValue(source)
    const dispatcher = makeDispatcher()
    const first = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { afterFingerprint: null })
    )
    if (
      !first.ok ||
      typeof first.result !== 'object' ||
      first.result === null ||
      !('fingerprint' in first.result) ||
      typeof first.result.fingerprint !== 'string'
    ) {
      throw new Error('Expected fingerprint')
    }
    source.sessions[0].title = 'Changed without a new scan stamp'
    const changed = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        afterFingerprint: first.result.fingerprint
      })
    )
    expect(changed).toMatchObject({
      ok: true,
      result: {
        sessions: [{ title: 'Changed without a new scan stamp' }],
        scannedAt: SCANNED_AT
      }
    })
    if (changed.ok) {
      expect(changed.result).not.toHaveProperty('unchanged')
      expect(changed.result).not.toMatchObject({ fingerprint: first.result.fingerprint })
    }
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    const forced = await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        afterFingerprint: first.result.fingerprint,
        force: true
      })
    )
    expect(forced.ok).toBe(true)
    if (forced.ok) {
      expect(forced.result).not.toHaveProperty('unchanged')
    }
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
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
    await listAiVaultSessions({ limit: 500 })
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
      expect.any(AbortSignal),
      expect.objectContaining({ work: expect.any(Function) })
    )
  })

  it('keeps a newer different-key scan dedupable after an older scan resolves', async () => {
    // A completed scan must not clear a different pending key and permit duplicate work.
    const deferreds: ((result: AiVaultListResult) => void)[] = []
    scanAiVaultSessionsInService.mockImplementation(
      () => new Promise<AiVaultListResult>((resolve) => deferreds.push(resolve))
    )
    // WSL-home resolution defers scanner invocation; wait for registration before resolving scans.
    const scanA = listAiVaultSessions({ limit: 100 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(1))
    const scanB = listAiVaultSessions({ limit: 200 })
    await vi.waitFor(() => expect(deferreds).toHaveLength(2))
    deferreds[0]?.(makeResult())
    await scanA
    const scanBAgain = listAiVaultSessions({ limit: 200 })
    // Flush a macrotask so an erroneous duplicate scan reaches the mock; assert the call count instead of hanging on its unresolved promise.
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
    const localResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', { limit: 500 })
    )) as { ok: boolean; result: AiVaultListResult }
    const runtimeResponse = (await dispatcher.dispatch(
      makeRequest('aiVault.listSessions', {
        limit: 500,
        executionHostId: 'runtime:remote-server'
      })
    )) as { ok: boolean; result: AiVaultListResult }

    // Host identity changes response stamps, never host-local scan/cache identity.
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      executionHostId: 'local'
    })

    expect(localResponse.result.sessions[0]?.executionHostId).toBe('local')
    expect(localResponse.result.scanId).toEqual(expect.any(String))
    expect(runtimeResponse.result).not.toHaveProperty('scanId')
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
    // Serve mode must source Codex homes from runtime, without window-only handler registration.
    expect(options?.additionalCodexSessionsDirs).toContain('/runtime/codex/home/sessions')
    expect(options?.wslHomeDirs).toEqual([])
  })

  it('forwards codex-home through the real OrcaRuntimeService construction path', async () => {
    // Use a real runtime to prove constructor-to-cache forwarding; directly seeding cache would miss a broken link.
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAdditionalAiVaultCodexHomePaths: () => ['/ctor/codex/home']
    })
    await runtime.listAiVaultSessions({})
    const options = scanAiVaultSessionsInService.mock.calls[0]?.[0]
    expect(options?.additionalCodexSessionsDirs).toContain('/ctor/codex/home/sessions')
  })
})
