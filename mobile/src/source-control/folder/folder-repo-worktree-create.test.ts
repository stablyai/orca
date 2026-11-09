import { describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { createFolderRepoWorktree, folderRepoCreateKey } from './folder-repo-worktree-create'

vi.mock('../../tasks/worktree-create-capability', () => ({
  readNewWorktreeRuntimeCapabilities: async () => ({ worktreeCreateIdempotency: false })
}))

const FOLDER = 'folder:f-1'

function refused(message: string): RpcResponse {
  return { id: '1', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'r' } }
}

const CREATED: RpcResponse = {
  id: '1',
  ok: true,
  result: { worktree: { id: 'repo-a::/w/payments', displayName: 'payments' } },
  _meta: { runtimeId: 'r' }
}

function createIn(client: FakeSession, repoId: string) {
  return createFolderRepoWorktree({
    key: folderRepoCreateKey({
      hostId: 'host-1',
      executionHost: undefined,
      folderWorktreeId: FOLDER,
      repoId
    }),
    client,
    repoId,
    folderWorktreeId: FOLDER,
    name: 'payments'
  })
}

describe('createFolderRepoWorktree', () => {
  it('sends one exact-name create attached to the folder', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(CREATED)

    await expect(createIn(client, 'repo-a')).resolves.toEqual({ kind: 'created', name: 'payments' })
    expect(client.sendRequest.mock.calls).toEqual([
      [
        'worktree.create',
        {
          repo: 'id:repo-a',
          name: 'payments',
          displayName: 'payments',
          displayNameKind: 'user',
          branchIntent: 'create-exact',
          setupDecision: 'inherit',
          parentWorkspace: FOLDER,
          parentWorkspaceOrigin: 'manual'
        },
        expect.anything()
      ]
    ])
  })

  it('sends nothing for a second tap while the first create runs', async () => {
    const client = new FakeSession('connected')
    let answer: (response: RpcResponse) => void = () => {}
    client.sendRequest.mockReturnValue(new Promise<RpcResponse>((resolve) => (answer = resolve)))

    const first = createIn(client, 'repo-b')
    await expect(createIn(client, 'repo-b')).resolves.toEqual({ kind: 'already-running' })
    answer(CREATED)
    await first
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the name is taken', 'Branch payments already exists\nworktree_create_exact_name_taken'],
    ['the repo asks about setup', 'Setup decision required for this repository']
  ])('hands the create to the composer when %s, without a second try', async (_case, message) => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(refused(message))

    await expect(createIn(client, `repo-${message.length}`)).resolves.toEqual({
      kind: 'needs-composer'
    })
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })
})
