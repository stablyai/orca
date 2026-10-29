import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { makeRequest, repoDispatcher } from './repo-rpc.test-fixture'

describe('repo RPC methods', () => {
  it('preserves the canonical action document through update, list and show envelopes', async () => {
    const sourceControlAi = {
      actionOverrides: {
        fixChecks: {
          agentId: 'codex' as const,
          agentArgs: '--search',
          launchPreferences: {
            agentId: 'claude' as const,
            permissionMode: 'ask' as const,
            modelSelection: {
              base: 'inherit' as const,
              model: { agentId: 'codex' as const, value: null }
            }
          },
          argumentChoices: {
            syntaxAgent: 'codex' as const,
            nodes: [{ at: 0, text: '-c model=o3' }]
          }
        }
      }
    }
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 0,
      sourceControlAi
    }
    const updateRepo = vi.fn<OrcaRuntimeService['updateRepo']>().mockResolvedValue(repo)
    const dispatcher = repoDispatcher({
      getRuntimeId: () => 'test-runtime',
      updateRepo,
      listVisibleRepos: () => [repo],
      showRepo: async () => repo
    })
    expect(
      await dispatcher.dispatch(
        makeRequest('repo.update', {
          repo: 'id:repo-1',
          updates: { sourceControlAi }
        })
      )
    ).toMatchObject({ ok: true, result: { repo: { sourceControlAi } } })
    expect(updateRepo).toHaveBeenCalledExactlyOnceWith('id:repo-1', { sourceControlAi })
    expect(await dispatcher.dispatch(makeRequest('repo.list'))).toMatchObject({
      ok: true,
      result: { repos: [{ sourceControlAi }] }
    })
    expect(
      await dispatcher.dispatch(makeRequest('repo.show', { repo: 'id:repo-1' }))
    ).toMatchObject({
      ok: true,
      result: { repo: { sourceControlAi } }
    })
  })
})
