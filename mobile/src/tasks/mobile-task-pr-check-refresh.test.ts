import { expect, it, vi } from 'vitest'
import { refreshMobileTaskPRChecks } from './mobile-task-pr-check-refresh'
import { item as makeItem } from './github-task-identity.test-fixture'
import { githubTaskKey } from './github-task-identity'
import { readRuntimeStatusProbe, recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
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

it.each(['reject', 'refuse', 'unknown', 'retired-selection', 'retired-owner'])(
  'settles unknown-host refresh independently of rows: %s',
  async (outcome) => {
    const item = makeItem('acme')
    const selected = {
      ...item,
      source: {
        ...item.source,
        headSha: 'h1',
        checksSummary: {
          state: 'success' as const,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          neutral: 0
        }
      }
    }
    let action: ActionableTaskItem | null = selected
    let items: TaskItem[] = [selected]
    let details: DetailPayload | null = {
      provider: 'github',
      targetKey: githubTaskKey(selected.source),
      body: '',
      labels: [],
      assignees: [],
      comments: [],
      reviewRequests: [],
      latestReviews: [],
      files: [],
      checks: [{ name: 'Previous', status: 'completed', conclusion: 'success', url: null }],
      headSha: 'h1'
    }
    const status = Promise.withResolvers<RpcResponse>()
    const rows = Promise.withResolvers<RpcResponse>()
    const owner = Promise.withResolvers<RpcResponse>()
    const rowsStarted = Promise.withResolvers<void>()
    const ownerStarted = Promise.withResolvers<void>()
    const sendRequest = vi.fn(
      async (method: string, _params?: unknown, _options?: SendRequestOptions) => {
        if (method === 'status.get') {
          return status.promise
        }
        if (method === 'github.workItemByOwnerRepo') {
          ownerStarted.resolve()
          return owner.promise
        }
        rowsStarted.resolve()
        return rows.promise
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connected fixture supplies the request and invocation lifecycle exercised below.
    const client = {
      sendRequest,
      getState: () => 'connected',
      getGeneration: () => 1,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {}
    } as unknown as RpcClient
    let current = true
    const finish = vi.fn()
    const setError = vi.fn()
    const pending = refreshMobileTaskPRChecks(
      {
        client,
        detailPayload: details,
        tryBeginMutation: () => finish,
        setError,
        claimPublication: () => () => current,
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
    await rowsStarted.promise
    expect(finish).not.toHaveBeenCalled()
    if (outcome === 'unknown') {
      rows.resolve({
        id: 'c',
        ok: true,
        result: [{ name: 'Build', status: 'completed', conclusion: 'failure', url: null }]
      })
      await pending
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'github.workItemByOwnerRepo')
      ).toHaveLength(0)
      expect(items[0].provider === 'github' && items[0].source.checksSummary?.state).toBe('failure')
      status.resolve({ id: 's', ok: true, result: { capabilities: [] } })
    } else {
      status.resolve({
        id: 's',
        ok: true,
        result: {
          runtimeId: 'r1',
          hostDescriptor: { installationId: 'host' },
          capabilities: [complete]
        }
      })
      await vi.waitFor(() =>
        expect(readRuntimeStatusProbe(client)?.capabilities).toEqual([complete])
      )
      if (outcome === 'retired-selection') {
        current = false
      }
      if (outcome === 'refuse') {
        rows.resolve({ id: 'c', ok: false, error: { code: 'UNAVAILABLE', message: 'rows failed' } })
      } else {
        rows.reject(new Error('rows failed'))
      }
      if (outcome !== 'retired-selection') {
        await ownerStarted.promise
        if (outcome === 'retired-owner') {
          current = false
        }
        owner.resolve({ id: 'o', ok: true, result: { ...selected.source, checksSummary: failure } })
      }
      await pending
      const requests = sendRequest.mock.calls.filter(
        ([method]) => method === 'github.workItemByOwnerRepo'
      )
      if (outcome === 'retired-selection') {
        expect(requests).toHaveLength(0)
        expect(setError.mock.calls).toEqual([['']])
      } else {
        expect(requests).toHaveLength(1)
        expect(requests[0][1]).toMatchObject({
          repo: 'id:clone',
          owner: 'acme',
          ownerRepo: 'widgets',
          host: 'github.corp',
          number: 93,
          type: 'pr'
        })
        expect(requests[0][2]?.envelope?.expectedRuntimeSource).toEqual({
          sourceId: 'host',
          runtimeId: 'r1'
        })
        expect(setError.mock.calls).toEqual([[''], ['rows failed']])
      }
      const expected = outcome.startsWith('retired') ? selected.source.checksSummary : failure
      expect(action?.provider === 'github' && action.source.checksSummary).toEqual(expected)
      expect(items[0].provider === 'github' && items[0].source.checksSummary).toEqual(expected)
      expect(details?.provider === 'github' && details.checks).toEqual([
        { name: 'Previous', status: 'completed', conclusion: 'success', url: null }
      ])
    }
    expect(finish).toHaveBeenCalledOnce()
  }
)
