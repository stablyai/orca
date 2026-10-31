import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { resolveCallerAutomationRun } from './automation-run-caller'
import { automationLaunchRunTarget } from './headless-dispatch'
import { reuseAutomationChat } from './automation-chat-session-reuse'
import type { AutomationRun } from '../../shared/automations-types'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ send })
}))

describe('automation chat reuse', () => {
  it('binds a reused session before handing off the next prompt', async () => {
    const state = buildProfileStateCutoverFixture('/fixture')
    const automation = { ...state.automations[0], agentId: 'claude' as const, workspaceId: 'wt-1' }
    const previous = {
      ...state.automationRuns[0],
      automationId: automation.id,
      status: 'completed' as const,
      sessionKind: 'chat' as const,
      chatSessionId: 'chat-1',
      createdAt: 1,
      dispatchedAt: 1,
      finishedAt: 2
    }
    let current: AutomationRun = {
      ...previous,
      id: 'next-run',
      status: 'dispatching' as const,
      chatSessionId: null,
      createdAt: 100_000_000,
      dispatchedAt: null
    }
    const records = {
      selectWritableRecord: () => ({ kind: 'writable' }),
      isSessionUnreadable: () => false,
      getConversation: () => ({ provider: 'claude', location: { workspaceId: 'wt-1' } })
    }
    const runtime = {
      openAgentSessionRecordStore: async () => records,
      ensureStructuredAgentSessionHost: async () => {}
    }
    send.mockImplementationOnce(async () => {
      expect(
        resolveCallerAutomationRun(
          [previous, current],
          { kind: 'chat', sessionIds: ['chat-1'] },
          current.createdAt
        ).id
      ).toBe(current.id)
      return { ok: true }
    })

    const result = await reuseAutomationChat(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: chat reuse reads only the record-store and host boundaries supplied above.
      runtime as never,
      {
        automation,
        run: current,
        target: { ok: true, cwd: '/fixture', repo: state.repos[0] },
        runs: [previous],
        agentPrompt: 'Run instructions\nCheck the repo',
        bindSession: (target) => {
          current = { ...current, ...automationLaunchRunTarget(target) }
        }
      }
    )

    expect(result?.chatSessionId).toBe('chat-1')
    expect(send).toHaveBeenCalledOnce()
  })
})
