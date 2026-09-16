import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { clearSearch, handlers, sshSearch, runtimeSearch } = vi.hoisted(() => ({
  clearSearch: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sshSearch: vi.fn(),
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
  requestActiveSshSessionSearch: sshSearch
}))

import { registerAiVaultSearchHandlers } from './ai-vault-search'
import { aiVaultApi } from '../../preload/api/ai-vault-bridge'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { fakeSearchService, searchResults } from '../../shared/ai-vault-search-test-fixture'
beforeEach(() => {
  handlers.clear()
  sshSearch.mockReset()
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
    for (const scope of ['all', 'nope', 'ssh:', 'runtime:a|b']) {
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
})
