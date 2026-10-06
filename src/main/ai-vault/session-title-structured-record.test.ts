import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { resolveLocalAiVaultSessionTitles } from './session-title-resolver'
import { parseAiVaultSessionTitlesResult } from './session-title-result-validation'
import { AiVaultSessionTitlesParams } from '../../shared/rpc-contract/ai-vault-params'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AiVaultSessionTitleRequest } from '../../shared/ai-vault-session-title'

const mocks = vi.hoisted(() => ({ scan: vi.fn(async () => ({ titles: [] })) }))
vi.mock('./session-scanner-background', () => ({
  resolveAiVaultSessionTitlesInBackground: mocks.scan
}))
const owner = { workspaceId: 'workspace-1', sessionId: 'session-alpha-1' }
const request: AiVaultSessionTitleRequest = {
  agent: 'claude',
  sessionId: 'provider-session-alpha-1',
  structuredSession: owner
}
function install(overrides: Partial<AgentSessionRecord> = {}): void {
  const record = {
    ...agentSessionRecordFixture(),
    conversationName: 'Saved record name',
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native title resolution only calls this getRecord member.
  setStructuredAgentSessionHost({
    deps: { store: { getRecord: (id: string) => (id === record.sessionId ? record : null) } }
  } as never)
}
afterEach(() => {
  setStructuredAgentSessionHost(null)
  mocks.scan.mockClear()
})
it('resolves an exact record with explicit ownership and preserves it through wire parsing', async () => {
  install()
  const parsed = AiVaultSessionTitlesParams.parse({ requests: [request] })
  const resolved = await resolveLocalAiVaultSessionTitles(parsed.requests)
  expect(resolved).toEqual({
    titles: [
      {
        agent: 'claude',
        sessionId: request.sessionId,
        title: 'Saved record name',
        structuredSession: owner
      }
    ]
  })
  expect(parseAiVaultSessionTitlesResult(resolved)).toEqual(resolved)
  expect(mocks.scan).not.toHaveBeenCalled()
})
it.each([
  { ...request, agent: 'codex' as const },
  { ...request, sessionId: 'other-provider-id' },
  { ...request, structuredSession: { ...owner, workspaceId: 'other-workspace' } },
  { ...request, structuredSession: { ...owner, sessionId: 'other-record' } }
])('refuses a different exact owner without transcript fallback: %j', async (different) => {
  install()
  expect(await resolveLocalAiVaultSessionTitles([different])).toEqual({ titles: [] })
  expect(mocks.scan).not.toHaveBeenCalled()
})
it.each(['ssh:remote', 'runtime:other'] as const)(
  'refuses a record owned by %s',
  async (executionHostId) => {
    install({ location: { ...agentSessionRecordFixture().location, executionHostId } })
    expect(await resolveLocalAiVaultSessionTitles([request])).toEqual({ titles: [] })
    expect(mocks.scan).not.toHaveBeenCalled()
  }
)
it('refuses WSL, unnamed and malformed owners and cancelled requests', async () => {
  install({ location: { ...agentSessionRecordFixture().location, wslDistro: 'Ubuntu' } })
  expect(await resolveLocalAiVaultSessionTitles([request])).toEqual({ titles: [] })
  install({ conversationName: undefined })
  expect(await resolveLocalAiVaultSessionTitles([request])).toEqual({ titles: [] })
  const malformed = { ...request }
  Reflect.set(malformed, 'structuredSession', null)
  expect(await resolveLocalAiVaultSessionTitles([malformed])).toEqual({ titles: [] })
  install()
  const controller = new AbortController()
  controller.abort()
  expect(await resolveLocalAiVaultSessionTitles([request], controller.signal)).toEqual({
    titles: []
  })
  expect(mocks.scan).not.toHaveBeenCalled()
})
it('keeps old requests unchanged and caps native requests at the existing batch size', async () => {
  install()
  const legacy = {
    agent: 'claude' as const,
    sessionId: 'legacy-session',
    transcriptPath: '/legacy.jsonl'
  }
  await resolveLocalAiVaultSessionTitles([legacy, request])
  expect(mocks.scan).toHaveBeenCalledExactlyOnceWith([legacy], undefined)
  expect(
    AiVaultSessionTitlesParams.safeParse({ requests: Array.from({ length: 65 }, () => request) })
      .success
  ).toBe(false)
  expect(
    await resolveLocalAiVaultSessionTitles([...Array.from({ length: 64 }, () => legacy), request])
  ).toEqual({ titles: [] })
})
it('retains ownership for historical provider handles without matching an unrelated chain', async () => {
  const record = agentSessionRecordFixture()
  install({
    providerHandleChain: [
      ...record.providerHandleChain,
      {
        ...record.providerHandleChain[0]!,
        linkId: 'next',
        handle: claudeProviderHandle('next-provider-id', null)
      }
    ]
  })
  expect((await resolveLocalAiVaultSessionTitles([request])).titles[0]?.structuredSession).toEqual(
    owner
  )
  expect(
    parseAiVaultSessionTitlesResult({
      titles: [{ agent: 'claude', sessionId: request.sessionId, title: 'Old host prompt' }]
    }).titles[0]?.structuredSession
  ).toBeUndefined()
  expect(() =>
    parseAiVaultSessionTitlesResult({
      titles: [
        {
          agent: 'claude',
          sessionId: request.sessionId,
          title: 'Name',
          structuredSession: { workspaceId: '', sessionId: owner.sessionId }
        }
      ]
    })
  ).toThrow()
})
