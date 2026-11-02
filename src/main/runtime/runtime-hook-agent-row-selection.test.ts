import { describe, expect, it } from 'vitest'
import {
  selectFreshAgentRowForMobileTab,
  selectFreshExplicitAgentStatus
} from './runtime-hook-agent-row-selection'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE_KEY = 'tab-1:22222222-2222-4222-8222-222222222222'
const HANDLE = 'term_selection'

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'worktree',
    connectionId: null,
    terminalHandle: HANDLE,
    state: 'working',
    prompt: 'ship it',
    agentType: 'codex',
    receivedAt: now,
    stateStartedAt: now - 500,
    ...overrides
  }
}

describe('selectFreshExplicitAgentStatus', () => {
  it('refuses restored, identity-only and stale evidence rows', () => {
    const args = { handle: HANDLE, paneKey: PANE_KEY }
    expect(
      selectFreshExplicitAgentStatus({ ...args, hookRows: [row({ restoredUnconfirmed: true })] })
    ).toBeNull()
    expect(
      selectFreshExplicitAgentStatus({ ...args, hookRows: [row({ providerSessionOnly: true })] })
    ).toBeNull()
    expect(
      selectFreshExplicitAgentStatus({
        ...args,
        hookRows: [row({ receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1 })]
      })
    ).toBeNull()
    expect(
      selectFreshExplicitAgentStatus({
        ...args,
        hookRows: [
          row({
            receivedAt: Date.now(),
            evidenceObservedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
          })
        ]
      })
    ).toBeNull()
  })
})

describe('selectFreshAgentRowForMobileTab', () => {
  it('prefers the pane own row over one that only shares its terminal', () => {
    const selected = selectFreshAgentRowForMobileTab({
      paneKey: PANE_KEY,
      terminalHandle: HANDLE,
      hookRows: [
        row({ paneKey: OTHER_PANE_KEY, prompt: 'sibling pane', receivedAt: Date.now() }),
        row({ prompt: 'this pane', receivedAt: Date.now() - 50 })
      ]
    })
    expect(selected?.payload.prompt).toBe('this pane')
  })

  it('refuses restored, resume-identity and stale rows', () => {
    const args = { paneKey: PANE_KEY, terminalHandle: HANDLE }
    expect(
      selectFreshAgentRowForMobileTab({ ...args, hookRows: [row({ restoredUnconfirmed: true })] })
    ).toBeNull()
    expect(
      selectFreshAgentRowForMobileTab({ ...args, hookRows: [row({ providerSessionOnly: true })] })
    ).toBeNull()
    expect(
      selectFreshAgentRowForMobileTab({
        ...args,
        hookRows: [row({ receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1 })]
      })
    ).toBeNull()
    expect(
      selectFreshAgentRowForMobileTab({
        ...args,
        hookRows: [
          row({
            receivedAt: Date.now(),
            evidenceObservedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
          })
        ]
      })
    ).toBeNull()
  })
})
