import { describe, expect, it } from 'vitest'
import type { AgentLaunchResult } from '../../../../src/shared/agent-launch/contracts/agent-launch-intent'
import { notificationPaneTab } from '../../session/tabs/notification-pane-tab'
import type { MobileSessionTab } from '../../session/tabs/mobile-session-tabs'
import { launchedAgentOpens } from './pr-ai-triage-launch'

function result(outcome: AgentLaunchResult['outcome']): AgentLaunchResult {
  return {
    outcome,
    worktreeId: 'wt-a',
    receipt: {
      mode: outcome.kind,
      preferred: outcome.kind,
      reason: 'requested',
      detail: 'Requested.'
    }
  }
}

// The id format createStructuredAgentSessionId produces: the agent, then a UUID with underscores.
const SESSION_ID = 'claude_11111111_2222_4333_8444_555555555555'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const chatTab = (id: string, sessionId = SESSION_ID): MobileSessionTab => ({
  type: 'agent-session',
  id,
  title: 'Chat',
  sessionId,
  agent: 'claude',
  isActive: false
})
const otherChatTab = chatTab('tab-other', 'claude_99999999_2222_4333_8444_555555555555')

// The session screen finds the tab to select from the pane key with notificationPaneTab.
describe('launchedAgentOpens', () => {
  it('names a chat by the tab the host reported, which the session screen finds', () => {
    const opens = launchedAgentOpens(
      result({ kind: 'structured', sessionId: SESSION_ID, handle: 'h', tabId: 'tab-9' })
    )
    expect(opens).toEqual({
      worktreeId: 'wt-a',
      paneKey: 'tab-9:7d731d20-5488-436f-ad53-d3e49333f320'
    })
    expect(notificationPaneTab([otherChatTab, chatTab('tab-9')], opens.paneKey ?? '')?.id).toBe(
      'tab-9'
    )
  })

  it('derives a chat’s tab from its session on a host that reports none', () => {
    const opens = launchedAgentOpens(
      result({ kind: 'structured', sessionId: SESSION_ID, handle: 'h' })
    )
    expect(opens).toEqual({
      worktreeId: 'wt-a',
      paneKey:
        'structured-agent-session-claude_11111111_2222_4333_8444_555555555555:7d731d20-5488-436f-ad53-d3e49333f320'
    })
    // The host may publish the chat under another tab id; the session id still finds it.
    expect(
      notificationPaneTab([otherChatTab, chatTab('host-tab-3')], opens.paneKey ?? '')?.id
    ).toBe('host-tab-3')
  })

  it('names a terminal by its pane, or by none when the host reported none', () => {
    const paneKey = `tab-1:${LEAF_ID}`
    const opens = launchedAgentOpens(result({ kind: 'terminal', handle: 'h', paneKey }))
    expect(opens).toEqual({ worktreeId: 'wt-a', paneKey })
    const terminal = (id: string, leafId: string): MobileSessionTab => ({
      type: 'terminal',
      id,
      title: 'Terminal',
      isActive: false,
      terminal: null,
      leafId
    })
    expect(
      notificationPaneTab(
        [terminal('tab-2', LEAF_ID), terminal('tab-1', LEAF_ID)],
        opens.paneKey ?? ''
      )?.id
    ).toBe('tab-1')
    expect(launchedAgentOpens(result({ kind: 'terminal', handle: 'h' }))).toEqual({
      worktreeId: 'wt-a',
      paneKey: null
    })
  })
})
