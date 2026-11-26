import { expect, it } from 'vitest'
import type { RpcContext } from '../../core'
import { AgentLaunchReplay } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import { AGENT_LAUNCH_METHODS } from './agent-launch'

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
