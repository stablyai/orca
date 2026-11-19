import { expect, it } from 'vitest'
import {
  createFakeRpcClient,
  rpcSuccess
} from '../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { requestWorktreeRemove } from './worktree-remove-request'

it('removes a folder row through folderWorkspace.delete, since no git selector names it', async () => {
  const client = createFakeRpcClient()
  const removing = requestWorktreeRemove(
    client,
    { worktreeId: 'folder:notes' },
    { runHooks: false }
  )
  await Promise.resolve()

  expect(client.requests.map((request) => [request.method, request.args[1]])).toEqual([
    [
      'folderWorkspace.delete',
      { folderWorkspaceId: 'notes', requireUniqueId: true, runHooks: false }
    ]
  ])
  client.requests[0].resolve(rpcSuccess('1', { deleted: true }))
  await expect(removing).resolves.toEqual({ accepted: true })
})
