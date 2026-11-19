import { expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import type { ClaudeAgentViewSnapshot } from '../../../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

const identity = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  sessionId: 'session',
  instanceId: 'instance'
}
const registration = {
  ...identity,
  action: 'register',
  keybindings:
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}',
  view: { revision: 1 }
}

it('offers a pre-hook registration only after session admission and retires it on pane cleanup', async () => {
  const server = new AgentHookServer()
  const bridge = server.claudeAgentViews
  let snapshot: ClaudeAgentViewSnapshot = []
  const unsubscribe = bridge.subscribe((next) => {
    snapshot = next
  })
  try {
    bridge.receive(registration)
    expect(snapshot).toEqual([])
    server.ingestRemote(
      {
        paneKey: identity.paneKey,
        providerSession: { key: 'session_id', id: 'session' },
        payload: { agentType: 'claude', state: 'done', prompt: '' }
      },
      'conn-1'
    )
    expect(snapshot).toEqual([{ paneKey: identity.paneKey, sessionId: 'session' }])
    expect(await bridge.view({ ...identity, trigger: async () => true })).toEqual({
      status: 'viewed'
    })
    server.clearPaneState(identity.paneKey)
    bridge.receive(registration)
    expect(snapshot).toEqual([])
    expect(await bridge.view({ ...identity, trigger: async () => true })).toEqual({
      status: 'unsupported'
    })
    server.ingestRemote(
      {
        paneKey: identity.paneKey,
        providerSession: { key: 'session_id', id: 'session' },
        payload: { agentType: 'claude', state: 'done', prompt: '' }
      },
      'conn-1'
    )
    bridge.receive(registration)
    expect(snapshot).toEqual([{ paneKey: identity.paneKey, sessionId: 'session' }])
    server.clearStatusEntriesForConnection('conn-1')
    expect(snapshot).toEqual([])
    server.dropStatusEntriesByTabPrefix('11111111-1111-4111-8111-111111111111')
    expect(bridge.receive(registration)).toEqual({})
  } finally {
    unsubscribe()
    server.stop()
  }
})

it('retires views on a proven agent exit and refuses late legacy registrations', async () => {
  const server = new AgentHookServer()
  const bridge = server.claudeAgentViews
  let snapshot: ClaudeAgentViewSnapshot = []
  const unsubscribe = bridge.subscribe((next) => {
    snapshot = next
  })
  try {
    server.ingestRemote(
      {
        paneKey: identity.paneKey,
        providerSession: { key: 'session_id', id: 'session' },
        payload: { agentType: 'claude', state: 'done', prompt: '' }
      },
      'conn-1'
    )
    bridge.receive(registration)
    const pending = bridge.view({ ...identity, agentId: 'child', trigger: async () => true })
    server.reconcileEndedProcessForPaneKeys([identity.paneKey], {
      preserveResumeIdentity: true,
      confirmedExit: true
    })
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(snapshot).toEqual([])
    expect(bridge.receive(registration)).toEqual({})
    expect(await bridge.view({ ...identity, trigger: async () => true })).toEqual({
      status: 'unsupported'
    })
  } finally {
    unsubscribe()
    server.stop()
  }
})
