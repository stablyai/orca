import './rpc/unused-default-rpc-methods.test-fixture'
import type * as GitHubClient from '../github/client'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import { GITHUB_REPO_WORK_ITEM_METHODS } from './rpc/methods/github-repo-work-item-methods'
import { RuntimeGitHubRepositoryQueryCommands } from './runtime-github-repository-query-commands'
import { OrcaRuntimeService } from './orca-runtime'
import type { Repo } from '../../shared/repo-types'
import { WorkItemDetails, WorkItem } from '../../shared/rpc-contract/github-repo-work-item-params'
import { RPC_PARAMS_BY_METHOD } from '../../shared/rpc-contract/rpc-params-catalog.generated'
const { read } = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null) }))
vi.mock('../github/work-item-details', () => ({ getWorkItemDetails: read }))
vi.mock('../github/client', async (original) => ({
  ...(await original<typeof GitHubClient>()),
  countWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  getWorkItemByOwnerRepo: vi.fn(),
  listAssignableUsers: vi.fn(),
  listIssues: vi.fn(),
  listLabels: vi.fn(),
  listWorkItems: vi.fn()
}))
vi.mock('../github/gh-account-binding-inventory', () => ({
  listGhAccountBindingInventory: vi.fn(),
  validateGhAccountBinding: vi.fn()
}))
vi.mock('../github/rate-limit', () => ({ getRateLimit: vi.fn() }))
vi.mock('../github/account-binding-required-host', () => ({
  resolveGhAccountRequiredHost: vi.fn()
}))

describe('registered direct details transport', () => {
  it.each([undefined, { owner: 'fork', repo: 'widgets', host: 'github.enterprise.test' }])(
    'passes old and canonical payloads through the real schema, catalog, dispatcher and registered execution: %j',
    async (ownerRepo) => {
      read.mockClear()
      const repo: Repo = {
        id: 'registered',
        path: '/registered/folder',
        kind: 'folder',
        displayName: 'folder',
        badgeColor: '',
        addedAt: 0,
        connectionId: 'ssh-target',
        issueSourcePreference: 'upstream',
        ghAccount: { host: 'github.enterprise.test', user: 'Alice' }
      }
      const options = { ghAccount: repo.ghAccount, wslDistro: 'Ubuntu-fixture' }
      const commands = new RuntimeGitHubRepositoryQueryCommands({
        resolveRepo: async (selector) => {
          expect(selector).toBe('id:registered')
          return repo
        },
        getLocalGitArgs: () => [options]
      })
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime')
      vi.spyOn(runtime, 'getRepoWorkItemDetails').mockImplementation(
        commands.getRepoWorkItemDetails.bind(commands)
      )
      const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_REPO_WORK_ITEM_METHODS })
      const payload = {
        repo: 'id:registered',
        number: 5,
        type: 'issue',
        ...(ownerRepo ? { ownerRepo } : {})
      }
      expect(WorkItemDetails.parse(payload)).toEqual(payload)
      expect(RPC_PARAMS_BY_METHOD['github.workItemDetails'].parse(payload)).toEqual(payload)
      expect(WorkItem.parse(payload)).toEqual({ repo: 'id:registered', number: 5, type: 'issue' })
      expect(
        await dispatcher.dispatch({
          id: 'read',
          authToken: 'fixture',
          method: 'github.workItemDetails',
          params: payload
        })
      ).toMatchObject({ ok: true, result: null })
      expect(read).toHaveBeenCalledExactlyOnceWith(
        repo.path,
        5,
        'issue',
        'ssh-target',
        options,
        'upstream',
        ownerRepo
      )
    }
  )
})
