import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from '../../../src/mobile-web/src/mobile-web-one-shot-request-client'
import { mobileWebHostRpcSender } from '../../../src/mobile-web/src/mobile-web-host-rpc-sender'
import { nativeHostTaskItemMutationOperations } from './native-host-task-item-mutation-operations'
import { nativeHostTaskListOperations } from './native-host-task-list-operations'
import { nativeHostTaskPreferenceOperations } from './native-host-task-preference-operations'
import { nativeHostTaskReadOperations } from './native-host-task-read-operations'
import { webHostTaskProjectReadOperations } from './web-host-task-project-read-operations'

type HostRequest = { method: string; params: Record<string, unknown> }

function hostFixture(reply: (request: HostRequest) => unknown) {
  const requests: HostRequest[] = []
  // The shared sender posts `workspace.hostRequest`; capture the inner method/params it forwards.
  const request = vi.fn(async (_capability: string, _operation: string, payload: HostRequest) => {
    requests.push({ method: payload.method, params: payload.params })
    return reply({ method: payload.method, params: payload.params })
  })
  const requestsClient = { request } as unknown as MobileWebOneShotRequestClient
  return { requests, sender: mobileWebHostRpcSender(requestsClient) }
}

function projectRow(index: number) {
  return {
    id: `row-${index}`,
    itemType: 'ISSUE' as const,
    position: index,
    updatedAt: '2026-09-07T00:00:00Z',
    fieldValuesByFieldId: {},
    content: {
      number: index + 1,
      title: `Item ${index}`,
      body: null,
      url: 'https://github.com/octo/app/issues/1',
      state: 'OPEN',
      isDraft: false,
      repository: 'octo/app',
      labels: [],
      assignees: []
    }
  }
}

function projectTable(rows: ReturnType<typeof projectRow>[], totalCount: number) {
  return {
    project: {
      owner: 'octo',
      ownerType: 'organization',
      number: 4,
      host: 'github.com',
      id: 'PVT_1',
      title: 'Roadmap',
      url: 'https://github.com/orgs/octo/projects/4'
    },
    selectedView: {
      id: 'PVTV_1',
      number: 1,
      name: 'Board',
      filter: '',
      layout: 'BOARD_LAYOUT',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    totalCount,
    rows
  }
}

const projectRequest = {
  owner: 'octo',
  ownerType: 'organization' as const,
  number: 4,
  viewId: 'PVTV_1'
}

describe('hosted task operations over the generic host lane', () => {
  it('names the desktop method the native app calls and sends no workspace handle', async () => {
    const f = hostFixture(() => ({ repos: [{ id: 'repo-1', displayName: 'app' }] }))
    await nativeHostTaskReadOperations(f.sender).listRepositories()
    expect(f.requests).toEqual([{ method: 'repo.list', params: {} }])
  })

  it('addresses a work item by its host repository and number, not an opaque handle', async () => {
    const f = hostFixture(() => ({ ok: true }))
    await nativeHostTaskItemMutationOperations(f.sender).setClosed(
      { provider: 'github', repoId: 'repo-1', number: 12, type: 'issue' },
      true
    )
    expect(f.requests[0]!.method).toBe('github.updateIssue')
    expect(f.requests[0]!.params).toMatchObject({ repo: 'id:repo-1', number: 12 })
  })

  it('forwards a list request unchanged and returns the host items', async () => {
    const f = hostFixture(() => ({ items: [{ number: 7, type: 'issue', title: 'Bug' }] }))
    const result = await nativeHostTaskListOperations(f.sender).listGitHub({
      repoId: 'repo-1',
      limit: 25,
      filter: 'all'
    } as Parameters<ReturnType<typeof nativeHostTaskListOperations>['listGitHub']>[0])
    expect(f.requests[0]!.method).toBe('github.listWorkItems')
    expect(result.items).toHaveLength(1)
  })

  it('writes a task preference straight to the desktop settings method', async () => {
    const f = hostFixture(() => ({}))
    await nativeHostTaskPreferenceOperations(f.sender).updateSettings({
      defaultTaskSource: 'github'
    })
    expect(f.requests).toEqual([
      { method: 'settings.update', params: { defaultTaskSource: 'github' } }
    ])
  })

  it('rejects when the desktop refuses the request', async () => {
    const requests = {
      request: vi.fn(async () => {
        throw new Error('forbidden')
      })
    } as unknown as MobileWebOneShotRequestClient
    await expect(
      nativeHostTaskReadOperations(mobileWebHostRpcSender(requests)).listRepositories()
    ).rejects.toThrow('forbidden')
  })

  it('reassembles a project table from every row window the desktop returns', async () => {
    const rows = [projectRow(0), projectRow(1), projectRow(2)]
    const f = hostFixture((request) => {
      const offset = (request.params.rowOffset as number) ?? 0
      const window = rows.slice(offset, offset + 2)
      return {
        data: projectTable(window, rows.length),
        ...(offset + window.length < rows.length ? { nextRowOffset: offset + window.length } : {})
      }
    })
    const table = await webHostTaskProjectReadOperations(f.sender).loadTable(projectRequest)
    expect(table.rows.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2'])
    expect(f.requests.map((request) => request.params.rowOffset)).toEqual([0, 2])
    expect(f.requests.every((request) => request.method === 'mobileWeb.tasks.projectTable')).toBe(
      true
    )
  })

  it('stops paging a project table when a window adds no rows', async () => {
    const f = hostFixture(() => ({ data: projectTable([], 0), nextRowOffset: 0 }))
    const table = await webHostTaskProjectReadOperations(f.sender).loadTable(projectRequest)
    expect(table.rows).toEqual([])
    expect(f.requests).toHaveLength(1)
  })

  it('rejects a project table the page schema does not accept', async () => {
    const f = hostFixture(() => ({ data: { rows: [{ id: 7 }] } }))
    await expect(
      webHostTaskProjectReadOperations(f.sender).loadTable(projectRequest)
    ).rejects.toThrow()
  })
})
