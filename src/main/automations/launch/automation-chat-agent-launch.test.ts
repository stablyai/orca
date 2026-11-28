import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import {
  launchAutomationChatAgent,
  type AutomationChatLaunchRequest
} from './automation-chat-agent-launch'

const launchAgentOnHost = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/rpc/methods/agent-launch/agent-launch', () => ({ launchAgentOnHost }))

const DISABLED = 'Agent opencode is disabled. Choose an enabled agent.'

function launch() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused launch reads only the run receipt store, which fails here.
  const runtime = {
    openAgentSessionRecordStore: () => Promise.reject(new Error('no store'))
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh existing-workspace launch reads only these fields before launchAgentOnHost.
  const request = {
    automation: {
      id: 'auto-1',
      agentId: 'opencode',
      prompt: 'hi',
      workspaceMode: 'existing',
      workspaceId: 'wt-1'
    },
    run: { id: 'run-1', title: 'Run', scheduledFor: 0, createdAt: 0 },
    target: { repo: { id: 'repo-1' } },
    runs: []
  } as unknown as AutomationChatLaunchRequest
  return launchAutomationChatAgent(runtime, request)
}

describe('launchAutomationChatAgent', () => {
  it.each([
    ['refused', new OrchestrationError('agent_unconfigured', DISABLED)],
    ['replayed', Object.assign(new Error(DISABLED), { code: 'agent_unconfigured' })]
  ])('keeps a %s disabled-agent refusal in its own words', async (_, refusal) => {
    launchAgentOnHost.mockRejectedValueOnce(refusal)
    await expect(launch()).rejects.toThrow(DISABLED)
  })
})
