import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { clearSearch, handlers, sshSearch, sshHostInfos, runtimeSearch } = vi.hoisted(() => ({
  clearSearch: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sshSearch: vi.fn(),
  sshHostInfos: vi.fn<() => { targetId: string }[]>(() => []),
  runtimeSearch: vi.fn()
}))
vi.mock('../ai-vault/session-scanner-service-spawn', () => ({
  clearSessionSearchInService: clearSearch
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) }
}))
vi.mock('./ssh', () => ({
  requestActiveSshSessionSearch: sshSearch,
  getActiveSshAiVaultHostInfos: sshHostInfos
}))

import { registerAiVaultSearchHandlers } from './ai-vault-search'
import { aiVaultApi } from '../../preload/api/ai-vault-bridge'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import {
  fakeSearchService,
  searchHit,
  searchResults
} from '../../shared/ai-vault-search-test-fixture'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
beforeEach(() => {
  handlers.clear()
  sshSearch.mockReset()
  sshHostInfos.mockReset()
  sshHostInfos.mockReturnValue([])
  runtimeSearch.mockReset()
  clearSearch.mockReset()
  registerAiVaultSearchHandlers({
    callRuntimeSearch: runtimeSearch
  })
})
afterEach(() => {
  setSessionSearchService(null)
  setStructuredAgentSessionHost(null)
})

describe('desktop IPC and preload search boundary', () => {
  it('round-trips local results and separate status through the actual preload', async () => {
    setSessionSearchService(fakeSearchService())
    expect(await aiVaultApi.searchSessions({ query: 'needle' })).toMatchObject({
      kind: 'results',
      hits: [
        {
          source: { presence: 'present', filePath: '/host/transcript.jsonl' },
          resumeCommand: 'host-resume-command'
        }
      ]
    })
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'local')).toMatchObject({
      hits: [{ source: { filePath: '/host/transcript.jsonl' } }]
    })
    expect(await aiVaultApi.searchStatus()).toMatchObject({ enabled: true, generation: 7 })
    expect(sshSearch).not.toHaveBeenCalled()
    expect(runtimeSearch).not.toHaveBeenCalled()
  })
  it('clears only the desktop-local child-owned index', async () => {
    clearSearch.mockResolvedValue(undefined)
    await aiVaultApi.clearSearchIndex()
    expect(clearSearch).toHaveBeenCalledOnce()
    expect(sshSearch).not.toHaveBeenCalled()
    expect(runtimeSearch).not.toHaveBeenCalled()
  })
  it('rejects malformed renderer input and uses typed unavailable', async () => {
    expect(await aiVaultApi.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    await expect(handlers.get('aiVault:searchSessions')!(null, { query: 1 })).rejects.toThrow()
    await expect(handlers.get('aiVault:searchStatus')!(null, 42)).rejects.toThrow()
  })
  it('routes one runtime environment over its RPC and stamps the answering host', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    runtimeSearch.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')
    expect(runtimeSearch).toHaveBeenCalledWith('env-1', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20,
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
    expect(result).toMatchObject({
      hits: [{ executionHostId: 'runtime:env-1', source: { presence: 'present' } }]
    })
    expect(JSON.stringify(result)).not.toContain('/host/transcript.jsonl')
    expect(local.search).not.toHaveBeenCalled()
    runtimeSearch.mockResolvedValue(unavailableSessionSearchStatus())
    expect(await aiVaultApi.searchStatus('runtime:env-1')).toEqual(unavailableSessionSearchStatus())
    expect(runtimeSearch).toHaveBeenLastCalledWith('env-1', 'aiVault.searchStatus', {})
  })
  it.each(['runtime:env-1'] as const)(
    'negotiates each actual remote leg once through preload scope %s',
    async (scope) => {
      const local = fakeSearchService()
      setSessionSearchService(local)
      sshHostInfos.mockReturnValue([{ targetId: 'ssh-host' }])
      const remoteReply = async (_host: string, method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), supportedAgents: [...AI_VAULT_AGENTS] }
          : { ...searchResults(), hits: [{ ...searchHit(), agent: 'jcode' }] }
      sshSearch.mockImplementation(remoteReply)
      runtimeSearch.mockImplementation(remoteReply)
      const result = await aiVaultApi.searchSessions(
        { query: 'needle', filters: { agents: [...AI_VAULT_AGENTS] } },
        scope
      )
      const calls = scope === 'runtime:env-1' ? runtimeSearch : sshSearch
      expect(calls.mock.calls.map((call) => call[1])).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
      const remoteHits =
        result.kind === 'results'
          ? result.hits.filter((hit) => hit.executionHostId !== 'local')
          : []
      expect(remoteHits).toMatchObject([{ agent: 'jcode', source: { presence: 'present' } }])
      expect(JSON.stringify(remoteHits)).not.toContain('/host/transcript')
      expect(JSON.stringify(remoteHits)).not.toContain('resumeCommand')
      expect(local.search).not.toHaveBeenCalled()
      expect(scope === 'runtime:env-1' ? sshSearch : runtimeSearch).not.toHaveBeenCalled()
    }
  )
  it('maps a runtime unknown-method refusal to unavailable and keeps transport errors', async () => {
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('unknown method'), { code: 'method_not_found' })
    )
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    // Status is the one read where "no such method" must not collapse into "off".
    await expect(aiVaultApi.searchStatus('runtime:env-1')).rejects.toThrow('host-too-old')
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('runtime disconnected'), { code: 'connection_lost' })
    )
    await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).rejects.toThrow(
      'runtime disconnected'
    )
  })
  it('reports unavailable when no runtime transport is injected', async () => {
    handlers.clear()
    registerAiVaultSearchHandlers()
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(await aiVaultApi.searchStatus('runtime:env-1')).toMatchObject({
      enabled: false,
      phase: 'idle'
    })
  })
  it('refuses an unroutable host instead of widening it to every host', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    for (const scope of ['nope', 'ssh:', 'runtime:a|b']) {
      await expect(
        handlers.get('aiVault:searchSessions')!(null, { query: 'needle' }, scope)
      ).rejects.toThrow('not available for this execution host')
      await expect(handlers.get('aiVault:searchStatus')!(null, scope)).rejects.toThrow(
        'not available for this execution host'
      )
    }
    expect(local.search).not.toHaveBeenCalled()
    expect(local.status).not.toHaveBeenCalled()
    expect(sshSearch).not.toHaveBeenCalled()
    expect(runtimeSearch).not.toHaveBeenCalled()
  })

  it('turns a paired runtime host on and answers with the status it reported', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    const enabled = { ...unavailableSessionSearchStatus(), enabled: true, generation: 4 }
    runtimeSearch.mockResolvedValue(enabled)

    expect(await aiVaultApi.setSearchEnabled('runtime:env-1', true)).toEqual(enabled)
    expect(runtimeSearch).toHaveBeenCalledExactlyOnceWith('env-1', 'aiVault.setSearchEnabled', {
      enabled: true
    })
    // The desktop's own index is never a side effect of enabling a remote one.
    expect(local.status).not.toHaveBeenCalled()
  })
  it('maps an unknown-method refusal to host-too-old and keeps every other failure', async () => {
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('Unknown method: aiVault.setSearchEnabled'), { code: -32601 })
    )
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow('host-too-old')

    runtimeSearch.mockRejectedValue(Object.assign(new Error('not paired'), { code: 'forbidden' }))
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow('not paired')
  })
  it('rejects a host answer that is not a status rather than reporting success', async () => {
    runtimeSearch.mockResolvedValue({ enabled: true })
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow()
  })
  it('refuses local, SSH, unroutable hosts and a non-boolean', async () => {
    await expect(aiVaultApi.setSearchEnabled('local', true)).rejects.toThrow('through Settings')
    await expect(aiVaultApi.setSearchEnabled('ssh:box', true)).rejects.toThrow('unsupported')
    await expect(handlers.get('aiVault:setSearchEnabled')!(null, 'nope', true)).rejects.toThrow(
      'not available for this execution host'
    )
    await expect(
      handlers.get('aiVault:setSearchEnabled')!(null, 'runtime:env-1', 'yes')
    ).rejects.toThrow()
    expect(runtimeSearch).not.toHaveBeenCalled()
    expect(sshSearch).not.toHaveBeenCalled()
  })
  it('reports host-too-old when this desktop has no runtime transport injected', async () => {
    handlers.clear()
    registerAiVaultSearchHandlers()
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow('host-too-old')
  })
})

describe('local search hits owned by a native chat', () => {
  function installChatHost(): { sessionId: string; workspaceId: string } {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'codex' as const,
      conversationName: 'Login repair'
    }
    record.providerHandleChain = [
      { ...record.providerHandleChain[0]!, handle: codexProviderHandle('host-session') }
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership projection only reads this record-list member.
    setStructuredAgentSessionHost({ deps: { store: { listRecords: () => [record] } } } as never)
    return { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
  }

  it('names and owns a hit after installing the chat host', async () => {
    setSessionSearchService(fakeSearchService())
    let owner: { sessionId: string; workspaceId: string } | null = null
    registerAiVaultSearchHandlers({
      ensureStructuredSessionOwnership: async () => {
        owner = installChatHost()
      }
    })
    const result = await aiVaultApi.searchSessions({ query: 'needle' })
    expect(result).toMatchObject({
      hits: [{ title: 'Login repair', structuredSession: owner! }]
    })
  })

  it('still answers with plain hits when the chat host will not install', async () => {
    setSessionSearchService(fakeSearchService())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerAiVaultSearchHandlers({
      ensureStructuredSessionOwnership: async () => {
        throw new Error('chat journal unavailable')
      }
    })
    const result = await aiVaultApi.searchSessions({ query: 'needle' })
    expect(result).toMatchObject({ hits: [{ title: 'Indexed conversation' }] })
    expect(JSON.stringify(result)).not.toContain('structuredSession')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
