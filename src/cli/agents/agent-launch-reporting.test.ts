import { expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITIES } from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { RuntimeClient } from '../runtime/client'
import {
  callAgentLaunch,
  formatAgentLaunch,
  type CliAgentLaunchTarget
} from './agent-launch-request'

it.each<CliAgentLaunchTarget>([
  { kind: 'existing', worktree: 'id:wt-fixture' },
  { kind: 'create-worktree', create: { repo: 'id:repo-fixture', name: 'task' } }
])('states the reporting contract for an independent launch in $kind', async (target) => {
  const client = new RuntimeClient('/tmp/orca-cli-reporting-fixture', 60_000, null, null)
  const invoke = vi.spyOn(client, 'call').mockResolvedValue({
    id: 'launch',
    ok: true,
    result: {
      outcome: { kind: 'structured', sessionId: 'chat-1', handle: 'agent-1' },
      worktreeId: 'wt-fixture',
      receipt: {
        mode: 'structured',
        preferred: 'structured',
        reason: 'user_default',
        detail: 'Started a structured chat session'
      }
    },
    _meta: { runtimeId: 'fixture-host' }
  })
  try {
    const reply = await callAgentLaunch(
      client,
      { agent: 'claude', surface: 'chat' },
      { target, presentation: 'background' },
      AGENT_LAUNCH_RUNTIME_CAPABILITIES
    )
    expect(reply.result.reporting).toEqual({
      automatic: false,
      guideCommand: 'orca skills get orchestration'
    })
    expect(formatAgentLaunch(reply.result)).toContain('completion is not automatically reported')
  } finally {
    invoke.mockRestore()
  }
})
