// P1-14: every agent-launch recovery method forwards the AUTHENTICATED
// pairedDeviceId alongside clientKind, so the runtime can scope caps, recovery
// rows, and idempotency to the calling device rather than to its client kind.
// The device id comes from the authenticated envelope only — never from params.
import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { WORKTREE_AGENT_LAUNCH_RECOVERY_METHODS } from './worktree-agent-launch-recovery-methods'

const CANONICAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function handler(name: string): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = WORKTREE_AGENT_LAUNCH_RECOVERY_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`${name} not registered`)
  }
  return method.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

// [rpc method, runtime method, params, trailing args before (clientKind, deviceId)]
const CASES: [string, string, Record<string, unknown>][] = [
  [
    'worktree.retryAgentLaunch',
    'retryWorktreeAgentLaunch',
    {
      worktree: 'id:wt-1',
      expectedFailureId: 'f1',
      clientMutationId: CANONICAL_UUID,
      action: { kind: 'same' }
    }
  ],
  [
    'worktree.forgetAgentLaunch',
    'forgetUnknownWorktreeAgentLaunch',
    {
      worktree: 'id:wt-1',
      expectedOperationId: 'op-1',
      clientMutationId: CANONICAL_UUID
    }
  ],
  [
    'worktree.retryBackgroundAgentLaunch',
    'retryBackgroundAgentLaunch',
    {
      attemptId: 'att-1',
      expectedFailureId: 'f1',
      clientMutationId: CANONICAL_UUID,
      action: { kind: 'same' }
    }
  ],
  [
    'worktree.forgetBackgroundAgentLaunch',
    'forgetBackgroundAgentLaunch',
    {
      attemptId: 'att-1',
      expectedOperationId: 'op-1',
      clientMutationId: CANONICAL_UUID
    }
  ],
  ['worktree.pendingAgentLaunchSummary', 'pendingAgentLaunchSummary', {}],
  [
    'worktree.unknownAgentLaunchSiblingCount',
    'unknownWorktreeAgentLaunchSiblingCount',
    { worktree: 'id:wt-1' }
  ],
  [
    'worktree.forgetUnknownAgentLaunchSiblings',
    'forgetUnknownWorktreeAgentLaunchSiblings',
    { worktree: 'id:wt-1' }
  ]
]

describe('worktree agent-launch recovery methods forward the paired device', () => {
  it.each(CASES)('%s passes pairedDeviceId to %s', async (rpcName, runtimeName, params) => {
    const spy = vi.fn().mockResolvedValue({})
    const runtime = {
      [runtimeName]: spy
    } as unknown as RpcContext['runtime']

    await handler(rpcName)(params, {
      runtime,
      clientKind: 'mobile',
      pairedDeviceId: 'device-a'
    })

    const args = spy.mock.calls[0]
    expect(args.slice(-2)).toEqual(['mobile', 'device-a'])
  })

  it.each(CASES)(
    '%s falls back to the coarse principal when no device is paired',
    async (rpcName, runtimeName, params) => {
      const spy = vi.fn().mockResolvedValue({})
      const runtime = {
        [runtimeName]: spy
      } as unknown as RpcContext['runtime']

      // In-process/local dispatch: no clientKind and no paired device id.
      await handler(rpcName)(params, { runtime })

      expect(spy.mock.calls[0].slice(-2)).toEqual([undefined, undefined])
    }
  )
})
