import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import { useHostQuery } from '../../query/host-query'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-host-scoped-rpc-client'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../test-support/rpc-recording/hook-mount'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import {
  folderSourceCatalogQuery,
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

describe('folder source catalog reads', () => {
  let renderer: ReactTestRenderer | null = null
  const queries = documentQueryClient()
  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await queries.end()
  })

  it.each([true, false])(
    "reads a server folder's catalog on the desktop's one event stream (subscribed: %s)",
    async (subscribed) => {
      let eventStreams = 0
      const desktop = stubRpcClient({
        getLastConnectedAt: () => 1,
        sendRequest: async (method) => ({
          id: '1',
          ok: true,
          result: method === 'repo.list' ? { repos: [] } : { groups: [GROUP] },
          _meta: { runtimeId: 'r' }
        }),
        subscribe: (method) => {
          if (method === 'runtime.clientEvents.subscribe') {
            eventStreams += 1
          }
          return () => {}
        }
      })
      const server = scopeRpcClientToExecutionHost(desktop, 'runtime:env-1')
      function Harness(): null {
        useHostQuery(
          folderSourceCatalogQuery,
          { hostId: 'host-1', client: desktop },
          { exec: 'local' },
          {},
          {
            subscribed: true
          }
        )
        useHostQuery(
          serverFolderSourceCatalogQuery,
          { hostId: 'host-1', client: server },
          { exec: 'runtime:env-1' },
          {},
          { subscribed }
        )
        return null
      }
      await act(async () => {
        renderer = create(queries.wrap(createElement(Harness)))
      })
      await settleQueryNotifications()

      expect(eventStreams).toBe(1)
    }
  )
})
