import { expect, it, vi } from 'vitest'
import { refreshMobileTaskPRChecks } from './mobile-task-pr-check-refresh'
import { item as makeItem } from './github-task-identity.test-fixture'
import { githubTaskKey } from './github-task-identity'
import { recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import type { RpcClient } from '../transport/rpc-client'
import type { ActionableTaskItem, TaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY as complete } from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'
import { isCompletePRCheckOwner } from '../../../src/shared/github/complete-pr-check-owner'

const failure = {
  state: 'failure' as const,
  total: 101,
  passed: 100,
  failed: 1,
  pending: 0,
  neutral: 0
}

it.each(['owner', 'rows', 'adoption'])(
  'publishes the other refresh result when %s fails',
  async (fails) => {
    const item = makeItem('acme')
    const source = { ...item.source, headSha: 'h1' }
    const selected = { ...item, source }
    let action: ActionableTaskItem | null = selected
    let items: TaskItem[] = [selected]
    let details: DetailPayload | null = {
      provider: 'github',
      targetKey: githubTaskKey(source),
      body: '',
      labels: [],
      assignees: [],
      comments: [],
      reviewRequests: [],
      latestReviews: [],
      files: [],
      checks: [],
      headSha: 'h1'
    }
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return {
          id: 's',
          ok: true as const,
          result: {
            runtimeId: 'r1',
            hostDescriptor: { installationId: 'host' },
            capabilities: [complete]
          }
        }
      }
      if (method === 'github.workItemByOwnerRepo') {
        if (fails === 'owner') {
          throw new Error('owner failed')
        }
        return { id: 'o', ok: true as const, result: { ...source, checksSummary: failure } }
      }
      if (fails === 'rows') {
        throw new Error('rows failed')
      }
      return {
        id: 'c',
        ok: true as const,
        result: [{ name: 'Build', status: 'completed', conclusion: 'success', url: null }]
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the connected request and invocation lifecycle used by this refresh.
    const client = {
      sendRequest,
      getState: () => 'connected',
      getGeneration: () => 1,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {}
    } as unknown as RpcClient
    if (fails !== 'adoption') {
      recordRuntimeStatusProbe(client, {
        runtimeId: 'r1',
        hostDescriptor: { installationId: 'host' },
        capabilities: [complete]
      })
    }
    const finish = vi.fn()
    await refreshMobileTaskPRChecks(
      {
        client,
        detailPayload: details,
        tryBeginMutation: () => finish,
        setError: vi.fn(),
        claimPublication: () => () => true,
        setActionItem: (update) => {
          action = typeof update === 'function' ? update(action) : update
        },
        setItems: (update) => {
          items = typeof update === 'function' ? update(items) : update
        },
        setDetailPayload: (update) => {
          details = typeof update === 'function' ? update(details) : update
        }
      },
      selected
    )
    expect(finish).toHaveBeenCalledOnce()
    if (fails !== 'owner') {
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'github.workItemByOwnerRepo')
      ).toHaveLength(1)
      expect(items[0].provider === 'github' && items[0].source.checksSummary).toEqual(failure)
    } else {
      expect(details?.provider === 'github' && details.checks).toHaveLength(1)
      expect(action?.provider === 'github' && isCompletePRCheckOwner(action.source)).toBe(true)
      expect(action?.provider === 'github' && action.source.checksSummary).toBeUndefined()
    }
  }
)
