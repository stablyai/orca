import { describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import {
  serverFolderSourceCatalogQuery,
  selectFolderSourceRepos
} from './folder-source-repos-query'

vi.mock('react-native', () => ({ AppState: {} }))

const GROUP = {
  id: 'group-1',
  name: 'payments',
  parentPath: '/src/payments',
  parentGroupId: null,
  createdFrom: 'folder',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function hostWith(repos: unknown[]): FakeSession {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string) => ({
    id: '1',
    ok: true,
    result: method === 'repo.list' ? { repos } : { groups: [GROUP] },
    _meta: { runtimeId: 'r' }
  }))
  return client
}

const repo = (id: string, path: string) => ({
  id,
  path,
  displayName: id,
  kind: 'git',
  badgeColor: 'gray',
  addedAt: 1
})

describe('folder source repositories', () => {
  it("offers a relayed server's repos in its folder", async () => {
    const client = hostWith([repo('api', '/src/payments/api'), repo('elsewhere', '/src/other')])
    const catalog = await serverFolderSourceCatalogQuery.fetch!(
      client,
      { exec: 'runtime:env-1' },
      {},
      undefined,
      { live: false, previousFromStore: false }
    )

    expect(selectFolderSourceRepos(catalog, 'group-1').map((found) => found.id)).toEqual(['api'])
  })
})
