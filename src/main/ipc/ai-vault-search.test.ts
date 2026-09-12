import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, remote } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  remote: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) }
}))
vi.mock('./ssh', () => ({ requestActiveSshSessionSearch: remote }))

import { registerAiVaultSearchHandlers } from './ai-vault-search'
import { aiVaultApi } from '../../preload/api/ai-vault-bridge'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import { fakeSearchService, searchResults } from '../../shared/ai-vault-search-test-fixture'

beforeEach(() => {
  handlers.clear()
  remote.mockReset()
  registerAiVaultSearchHandlers()
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
    expect(await aiVaultApi.searchStatus()).toMatchObject({ enabled: true, generation: 7 })
  })
  it('rejects malformed renderer input and uses typed unavailable', async () => {
    expect(await aiVaultApi.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(() => handlers.get('aiVault:searchSessions')!(null, { query: 1 })).toThrow()
    expect(() => handlers.get('aiVault:searchStatus')!(null, 42)).toThrow()
  })
  it('routes one SSH target without touching the local index and redacts received paths', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    remote.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'ssh-host')
    expect(remote).toHaveBeenCalledWith('ssh-host', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20
    })
    expect(result).toMatchObject({ hits: [{ source: { presence: 'present' } }] })
    expect(JSON.stringify(result)).not.toContain('resumeCommand')
    expect(local.search).not.toHaveBeenCalled()
    remote.mockRejectedValue(new Error('SSH relay is not ready'))
    await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'ssh-host')).rejects.toThrow(
      'SSH relay is not ready'
    )
    expect(local.search).not.toHaveBeenCalled()
  })
})
