import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'
import { WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function repoDispatcher(
  runtime: Pick<OrcaRuntimeService, 'getRuntimeId'> & Partial<OrcaRuntimeService>
) {
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These RPC cases supply every runtime method their handlers and envelope access.
    runtime: runtime as OrcaRuntimeService,
    methods: REPO_METHODS
  })
}

describe('repo.update agentAccounts', () => {
  it('persists normalized agentAccounts and clear sentinels, and omits malformed input', async () => {
    const updateRepo = vi.fn().mockResolvedValue({
      id: 'repo-1',
      path: '/srv/repo',
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0,
      agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } }
    })
    const dispatcher = repoDispatcher({ getRuntimeId: () => 'test-runtime', updateRepo })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { agentAccounts: { claude: { mode: 'account', accountId: ' acct-1 ' } } }
      }),
      { clientCapabilities: [WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY] }
    )

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } }
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        repo: { id: 'repo-1', agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } } }
      }
    })

    await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { agentAccounts: null }
      })
    )
    expect(updateRepo).toHaveBeenLastCalledWith('repo-1', { agentAccounts: null })

    await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercising malformed transport input on purpose; the schema must drop it rather than coerce it.
        updates: { agentAccounts: { claude: { mode: 'bogus' } } as never }
      })
    )
    expect(updateRepo).toHaveBeenLastCalledWith('repo-1', {})
  })
})
