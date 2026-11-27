// Rule 6 (teammate-rules.ts): a workspace's unread mark and its attention are the owner's. A teammate
// reading a shared agent's workspace never writes either; the owner's own read does.
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../core'
import type { BotShareCallerScope } from '../../callers/rpc-caller-scope'
import { WORKTREE_SET_METHOD } from './worktree-set-method'

afterEach(() => vi.restoreAllMocks())

const TEAMMATE: BotShareCallerScope = {
  kind: 'bot-share',
  botId: 'bot-1',
  accountId: 'usr_mate',
  workspaceTier: true
}

/** What one read of a workspace (`isUnread: false`, acknowledging attention) writes, by caller. */
async function readWrites(callerScope: RpcContext['callerScope']) {
  const runtime = new OrcaRuntimeService()
  // The two writes of the owner's marks, seen as the handler makes them; no store is opened.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only returns the updated workspace.
  const meta = vi.spyOn(runtime, 'updateManagedWorktreeMeta').mockResolvedValue({} as never)
  vi.spyOn(runtime, 'prepareWorkspaceAttentionAcknowledgement').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the acknowledgement spy alone.
    {} as never
  )
  const acknowledged = vi.spyOn(runtime, 'acknowledgeNotificationAttention').mockReturnValue()
  await WORKTREE_SET_METHOD.handler(
    WORKTREE_SET_METHOD.params!.parse({
      worktree: 'id:wt-1',
      isUnread: false,
      acknowledgeAttention: true
    }),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these two fields.
    { runtime, callerScope } as RpcContext
  )
  return { unread: meta.mock.calls[0]?.[1].isUnread, acknowledged: acknowledged.mock.calls.length }
}

it('writes the workspace’s read marks for the owner’s read alone', async () => {
  expect(await readWrites({ kind: 'runtime-paired', grants: [] })).toEqual({
    unread: false,
    acknowledged: 1
  })
  expect(await readWrites(TEAMMATE)).toEqual({ unread: undefined, acknowledged: 0 })
})
