import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { scopeGitHubQuery, searchLinearIssues } from './smart-source-search-requests'

type Call = { method: string; params: Record<string, unknown> }

function fakeClient(result: unknown, calls: Call[]): RpcClient {
  return {
    sendRequest: async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
    }
  } as unknown as RpcClient
}

describe('scopeGitHubQuery', () => {
  it('passes the raw trimmed query so BOTH issues and PRs are returned', () => {
    // Empty stays empty (runtime lists recent issues + PRs); no forced is:issue.
    expect(scopeGitHubQuery('')).toBe('')
    expect(scopeGitHubQuery('  login bug  ')).toBe('login bug')
  })

  it('preserves an explicit is:pr / is:issue scope the user typed', () => {
    expect(scopeGitHubQuery('is:pr auth')).toBe('is:pr auth')
    expect(scopeGitHubQuery('is:issue auth')).toBe('is:issue auth')
  })
})

describe('searchLinearIssues', () => {
  it('lists assigned issues for an empty query (desktop default)', async () => {
    const calls: Call[] = []
    const client = fakeClient({ items: [] }, calls)
    await searchLinearIssues(client, '', null)
    expect(calls[0]!.method).toBe('linear.listIssues')
    expect(calls[0]!.params).toMatchObject({ filter: 'assigned' })
  })

  it('searches when a query is present', async () => {
    const calls: Call[] = []
    const client = fakeClient({ items: [] }, calls)
    await searchLinearIssues(client, 'bug', 'ws-1')
    expect(calls[0]!.method).toBe('linear.searchIssues')
    expect(calls[0]!.params).toMatchObject({ query: 'bug', workspaceId: 'ws-1' })
  })
})
