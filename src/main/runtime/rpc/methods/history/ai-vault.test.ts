import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RpcDispatcher } from '../../dispatcher'

import type { RpcRequest } from '../../core'

import type { OrcaRuntimeService } from '../../../orca-runtime'

import '../../../orca-runtime'
import { RuntimeAiVaultCommands } from '../../../integrations/ai-vault/runtime-ai-vault-commands'

import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../shared/ai-vault/contracts/ai-vault-types'

import type { AiVaultServiceScanOptions } from '../../../../ai-vault/scan-service/session-scanner-service-protocol'

import '../../../../../shared/protocol-version'
import '../../../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'

const { scanAiVaultSessionsInService, resolveAiVaultSessionTitlesInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService:
    vi.fn<
      (options: AiVaultServiceScanOptions, signal?: AbortSignal) => Promise<AiVaultListResult>
    >(),
  resolveAiVaultSessionTitlesInService: vi.fn()
}))

vi.mock(
  '../../../../ai-vault/scan-service/session-scanner-service-spawn',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    scanAiVaultSessionsInService,
    resolveAiVaultSessionTitlesInService
  })
)

import { AI_VAULT_METHODS } from './ai-vault'

import '../../../../../shared/rpc-contract/ai-vault-params'
import { agentSessionRefusalError } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'

import { recordStructuredAgentSessionHostInstallRefusal } from '../../../agent-session/structured-agent-session-host-refusal'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { installOwnership } from '../../../../ai-vault/structured-session-ownership.test-support'
import {
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from '../../../../ai-vault/cached-session-list'

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
})
