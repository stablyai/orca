import './rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import { RpcDispatcher } from './rpc/dispatcher'
import { GITHUB_PULL_REQUEST_METHODS } from './rpc/methods/github-pull-request-methods'

const { detailsMock } = vi.hoisted(() => ({ detailsMock: vi.fn() }))
vi.mock('../github/client', () => ({
  getPRCheckDetails: detailsMock,
  getPRChecks: vi.fn(),
  getPRComments: vi.fn(),
  getIssue: vi.fn()
}))
vi.mock('../github/work-item-details', () => ({ getPRFileContents: vi.fn() }))

describe('handling-host check detail query command', () => {
  beforeEach(() => {
    detailsMock.mockReset()
  })

  it.each(['failure', 'disconnect'])(
    'delegates %s once with registered folder/account/SSH context and caller signal',
    async (mode) => {
      const repo: Repo = {
        id: 'registered-folder',
        path: '/registered/folder',
        kind: 'folder',
        displayName: 'folder',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-fixture',
        ghAccount: { host: 'github.enterprise.test', user: 'Alice' }
      }
      const resolveRepo = vi.fn(async (selector: string) => {
        expect(selector).toBe('id:registered-folder')
        return repo
      })
      const localOptions = { ghAccount: repo.ghAccount, wslDistro: 'Ubuntu-fixture' }
      const query = new RuntimeGitHubReviewQueryCommands({
        resolveRepo,
        getLocalGitArgs: () => [localOptions]
      })
      const delegate = vi.spyOn(query, 'getRepoPRCheckDetails')
      const runtime = {
        getRuntimeId: () => 'handling-host',
        getRepoPRCheckDetails: query.getRepoPRCheckDetails.bind(query)
      }
      const dispatcher = new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This explicit registry invokes only getRuntimeId and the real query method.
        runtime: runtime as unknown as OrcaRuntimeService,
        methods: GITHUB_PULL_REQUEST_METHODS
      })
      const controller = new AbortController()
      const prRepo = { owner: 'base', repo: 'widgets', host: 'github.enterprise.test' }
      const error = new Error(
        mode === 'failure'
          ? 'Could not load check details.'
          : 'Check details request was cancelled.'
      )
      if (mode === 'disconnect') {
        error.name = 'AbortError'
      }
      detailsMock.mockImplementation(async () => {
        if (mode === 'disconnect') {
          controller.abort()
        }
        throw error
      })
      const response = await dispatcher.dispatch(
        {
          id: 'details',
          authToken: 'fixture',
          method: 'github.prCheckDetails',
          params: { repo: 'id:registered-folder', checkRunId: 9, prRepo }
        },
        { signal: controller.signal }
      )
      expect(response).toMatchObject({ ok: false, error: { message: error.message } })
      expect(delegate).toHaveBeenCalledOnce()
      expect(resolveRepo).toHaveBeenCalledOnce()
      expect(detailsMock).toHaveBeenCalledExactlyOnceWith(
        repo.path,
        { checkRunId: 9, workflowRunId: undefined, checkName: undefined, url: undefined, prRepo },
        'ssh-fixture',
        localOptions,
        controller.signal
      )
    }
  )
})
