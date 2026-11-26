import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { defineHostMutation } from '../query/host-mutation'
import { worktreeDisplayNameWrite } from './host-screen-operations'

async function sendWorkspaceRename(
  client: RpcClient,
  vars: { worktreeId: string; displayName: string }
): Promise<void> {
  worktreeDisplayNameWrite.interpret(
    await worktreeDisplayNameWrite.request(client, {
      worktree: `id:${vars.worktreeId}`,
      displayName: vars.displayName
    })
  )
}

export const workspaceRename = defineHostMutation({
  offline: 'draft',
  send: sendWorkspaceRename,
  // Renaming is idempotent, so a lost reply is settled by sending the same name again.
  confirm: sendWorkspaceRename
})
