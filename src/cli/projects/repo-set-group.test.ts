import { afterEach, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { REPO_HANDLERS } from './repo'

afterEach(() => {
  vi.restoreAllMocks()
})

it('moves a repo it has just renamed by id, not by the name that no longer matches', async () => {
  const call = vi.fn(async (method: string, _params?: unknown) => ({
    result:
      method === 'projectGroup.list'
        ? { groups: [{ id: 'g1', name: 'Clients', parentGroupId: null }] }
        : { repo: { id: 'r1' } }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo set only uses client.call.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  const flags = new Map<string, string | boolean>([
    ['repo', 'name:acme-web'],
    ['display-name', 'Acme Web'],
    ['group', 'Clients']
  ])
  const ctx: HandlerContext = { flags, client, cwd: '/', json: true }
  vi.spyOn(console, 'log').mockReturnValue(undefined)

  await REPO_HANDLERS['repo set'](ctx)

  expect(call.mock.calls.slice(1)).toEqual([
    ['repo.update', { repo: 'name:acme-web', updates: { displayName: 'Acme Web' } }],
    ['projectGroup.moveProject', { repo: 'id:r1', groupId: 'g1' }]
  ])
})
