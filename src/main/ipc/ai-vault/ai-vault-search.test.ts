import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { clearSearch, handlers, sshSearch, sshHostInfos, runtimeSearch } = vi.hoisted(() => ({
  clearSearch: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sshSearch: vi.fn(),
  sshHostInfos: vi.fn<() => { targetId: string }[]>(() => []),
  runtimeSearch: vi.fn()
}))
vi.mock('../../ai-vault/scan-service/session-scanner-service-spawn', () => ({
  clearSessionSearchInService: clearSearch
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) }
}))
vi.mock('../ssh/ssh', () => ({
  requestActiveSshSessionSearch: sshSearch,
  getActiveSshAiVaultHostInfos: sshHostInfos
}))

import { createChildSessionSearchService } from '../../ai-vault-search/session-search-child-service'
import { registerAiVaultSearchHandlers } from './ai-vault-search'
import { aiVaultApi } from '../../../preload/api/ai-vault/ai-vault-bridge'
import { setSessionSearchService } from '../../ai-vault-search/session-search-service-registry'
import { fakeSearchService } from '../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
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

  it('maps an unknown-method refusal to host-too-old and keeps every other failure', async () => {
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('Unknown method: aiVault.setSearchEnabled'), { code: -32601 })
    )
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow('host-too-old')

    runtimeSearch.mockRejectedValue(Object.assign(new Error('not paired'), { code: 'forbidden' }))
    await expect(aiVaultApi.setSearchEnabled('runtime:env-1', true)).rejects.toThrow('not paired')
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
})

it('preserves a child reader failure through registry, IPC and preload', async () => {
  const service = fakeSearchService()
  service.search.mockRejectedValue(new Error('reader deadline exceeded'))
  setSessionSearchService(
    createChildSessionSearchService({
      search: service.search,
      status: service.status,
      reconcile: service.reconcile
    })
  )
  await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'local')).rejects.toThrow(
    'reader deadline exceeded'
  )
})
