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
import {
  fakeSearchService,
  searchHit,
  searchResults
} from '../../shared/ai-vault-search-test-fixture'
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
afterEach(() => setSessionSearchService(null))

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
  it('routes one SSH target without touching the local index and redacts received paths', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    sshSearch.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'ssh:ssh-host')
    expect(sshSearch).toHaveBeenCalledWith('ssh-host', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20
    })
    expect(result).toMatchObject({
      hits: [{ executionHostId: 'ssh:ssh-host', source: { presence: 'present' } }]
    })
    expect(JSON.stringify(result)).not.toContain('resumeCommand')
    expect(local.search).not.toHaveBeenCalled()
    sshSearch.mockRejectedValue(new Error('SSH relay is not ready'))
    await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'ssh:ssh-host')).rejects.toThrow(
      'SSH relay is not ready'
    )
    expect(local.search).not.toHaveBeenCalled()
  })
  it('routes one runtime environment over its RPC and stamps the answering host', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    runtimeSearch.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')
    expect(runtimeSearch).toHaveBeenCalledWith('env-1', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20
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
  it('merges every enumerated host under the all scope, and still refuses an all status', async () => {
    setSessionSearchService(fakeSearchService())
    sshHostInfos.mockReturnValue([{ targetId: 'box' }])
    sshSearch.mockResolvedValue({
      ...searchResults(),
      hits: [{ ...searchHit(), sessionId: 'far' }]
    })
    const merged = await aiVaultApi.searchSessions({ query: 'needle' }, 'all')
    expect(merged).toMatchObject({
      kind: 'results',
      hosts: [
        { executionHostId: 'local', outcome: 'searched' },
        { executionHostId: 'ssh:box', outcome: 'searched' }
      ]
    })
    expect(
      merged.kind === 'results'
        ? merged.hits.map((hit) => [hit.executionHostId, hit.sessionId])
        : null
    ).toEqual([
      ['local', 'host-session'],
      ['ssh:box', 'far']
    ])
    // A merged status would have to reconcile six phases into one; it stays refused.
    await expect(handlers.get('aiVault:searchStatus')!(null, 'all')).rejects.toThrow(
      'not available for this execution host'
    )
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
