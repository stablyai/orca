import { expect, it } from 'vitest'
import type { RpcContext } from '../../core'
import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { AgentLaunchReplay } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { placeLaunchedChat } from './agent-launch-split'

it("refuses a paired device's split before either launch method touches the host", async () => {
  // Any read of the host fails with its own error, so only a refusal that comes first passes.
  const runtime = new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`runtime.${String(key)} touched`)
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refusal reads only the caller; any runtime read throws.
  const context = {
    runtime,
    caller: { kind: 'paired-device', deviceId: 'phone' }
  } as unknown as RpcContext
  const raw = {
    agent: 'claude',
    target: { kind: 'existing', worktree: 'active' },
    surface: 'chat',
    operationId: '1795651423019-c02333849f1f43269453d392280fc5b5',
    placement: { split: { direction: 'right' } }
  }
  // Replay's schema requires the operation id, so these params fit both methods.
  const params = AgentLaunchReplay.parse(raw)
  const [launchReplay, launch] = AGENT_LAUNCH_METHODS
  await expect(launchReplay.handler(params, context)).rejects.toThrow(
    'agent_launch_split_unsupported'
  )
  await expect(launch.handler(params, context)).rejects.toThrow('agent_launch_split_unsupported')
})

it('claims no placement for a chat when the window is gone, only for a terminal fallback', async () => {
  const runtime = { placeAgentLaunchSplit: () => null }
  const view = {
    early: null,
    presentation: 'background' as const,
    split: { direction: 'right' as const }
  }
  const launched = {
    worktreeId: 'w1',
    receipt: { mode: 'structured', reason: 'requested', detail: '' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only outcome and worktreeId.
  const chat = {
    ...launched,
    outcome: { kind: 'structured', sessionId: 's1', handle: 'h1' }
  } as unknown as AgentLaunchResult
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const terminal = {
    ...launched,
    outcome: { kind: 'terminal', handle: 'h2' }
  } as unknown as AgentLaunchResult

  expect(await placeLaunchedChat(runtime, chat, view)).toEqual({})
  expect(await placeLaunchedChat(runtime, terminal, view)).toEqual({
    placement: { groupId: '', fallback: 'not-split' }
  })
})
