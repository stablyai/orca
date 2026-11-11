import { expect, it } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeAgentRowSnapshot } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'

it('does not pair a retained model with another provider session on the phone', () => {
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: 'tab:leaf',
    title: 'Claude',
    parentTabId: 'tab',
    leafId: 'leaf',
    isActive: true,
    launchAgent: 'claude'
  }
  const retained: RuntimeAgentRowSnapshot = {
    paneKey: 'tab:leaf',
    connectionId: null,
    stateStartedAt: Date.now(),
    updatedAt: Date.now(),
    providerSession: { key: 'session_id', id: 'A' },
    payload: {
      agentType: 'claude',
      state: 'working',
      prompt: 'continue',
      model: 'claude-opus-5-5[1m]'
    }
  }
  const successor: AgentStatusIpcPayload = {
    paneKey: 'tab:leaf',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    providerSessionOnly: true,
    providerSession: { key: 'session_id', id: 'B' }
  }
  const host = { getPaneKey: () => 'tab:leaf', getLeaf: () => null, getTrackedTitle: () => null }
  const replaced = buildRuntimeMobileAgentStatus(
    null,
    tab,
    'handle',
    retained,
    () => [successor],
    host
  )
  expect(replaced.agentStatus?.providerSession?.id).toBe('B')
  expect(replaced.agentStatus?.model).toBeUndefined()
  const same = buildRuntimeMobileAgentStatus(null, tab, 'handle', retained, () => [], host)
  expect(same.agentStatus?.providerSession?.id).toBe('A')
  expect(same.agentStatus?.model).toBe('claude-opus-5-5[1m]')
})

it('keeps a headless hook model with its own session and excludes it from a newer identity-only row', () => {
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: 'tab:leaf',
    title: 'Codex',
    parentTabId: 'tab',
    leafId: 'leaf',
    isActive: true,
    launchAgent: 'codex'
  }
  const row: AgentStatusIpcPayload = {
    paneKey: 'tab:leaf',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    agentType: 'codex',
    state: 'working',
    prompt: '',
    model: 'gpt-5.5',
    providerSession: { key: 'session_id', id: 'A' }
  }
  const host = { getPaneKey: () => 'tab:leaf', getLeaf: () => null, getTrackedTitle: () => null }
  const same = buildRuntimeMobileAgentStatus(null, tab, 'handle', null, () => [row], host)
  expect(same.agentStatus?.providerSession?.id).toBe('A')
  expect(same.agentStatus?.model).toBe('gpt-5.5')
  const newer: AgentStatusIpcPayload = {
    ...row,
    receivedAt: row.receivedAt + 1,
    providerSessionOnly: true,
    providerSession: { key: 'session_id', id: 'B' }
  }
  const replaced = buildRuntimeMobileAgentStatus(
    null,
    tab,
    'handle',
    null,
    () => [row, newer],
    host
  )
  expect(replaced.agentStatus?.providerSession?.id).toBe('B')
  expect(replaced.agentStatus?.model).toBeUndefined()
})
