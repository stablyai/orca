import { describe, expect, it } from 'vitest'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const paneKey = 'worktree:tab:0'
const now = Date.now()
const hookRow: AgentStatusIpcPayload = {
  paneKey,
  tabId: 'tab',
  terminalHandle: 'term_row',
  worktreeId: 'worktree',
  connectionId: null,
  state: 'working',
  prompt: 'implement',
  agentType: 'codex',
  stateStartedAt: now,
  receivedAt: now
}
const base = {
  hookSnapshots: [hookRow],
  mirroredWorktreeIdByTabId: new Map<string, string>(),
  connectedPtyEvidence: {
    tabIds: new Set<string>(),
    paneKeys: new Set<string>(),
    ptyIdByTerminalHandle: new Map<string, string>()
  }
}
const connected = {
  ...base,
  connectedPtyEvidence: {
    tabIds: new Set(['tab']),
    paneKeys: new Set([paneKey]),
    ptyIdByTerminalHandle: new Map([['term_row', 'pty']])
  }
}

describe('worktree agent source admission', () => {
  it('rejects a disconnected local terminal before row assembly', () => {
    expect(collectRuntimeWorktreeAgentSources(base).size).toBe(0)
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.state).toBe('working')
  })

  it('keeps remote evidence and resolves mirrored workspace ownership', () => {
    const remote = { ...hookRow, connectionId: 'ssh-connection' }
    expect(collectRuntimeWorktreeAgentSources({ ...base, hookSnapshots: [remote] }).size).toBe(1)
    const sources = collectRuntimeWorktreeAgentSources({
      ...base,
      mirroredWorktreeIdByTabId: new Map([['tab', 'remote-worktree']])
    })
    expect(sources.get(paneKey)?.worktreeId).toBe('remote-worktree')
  })

  it('rejoins the row to the connected PTY behind its terminal handle', () => {
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.ptyId).toBe('pty')
    // The handle is the last rescue once a controller incarnation nulls the pane binding.
    const bindingCleared = collectRuntimeWorktreeAgentSources({
      ...base,
      connectedPtyEvidence: {
        ...base.connectedPtyEvidence,
        ptyIdByTerminalHandle: new Map([['term_row', 'pty']])
      }
    })
    expect(bindingCleared.get(paneKey)?.ptyId).toBe('pty')
    // No connected PTY answers to the handle and no pane evidence: the row is not admitted.
    expect(collectRuntimeWorktreeAgentSources(base).size).toBe(0)
  })

  it('carries the row own working mode and drops restored rows', () => {
    const monitoring = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, workingMode: 'monitoring' as const }]
    })
    expect(monitoring.get(paneKey)).toMatchObject({ updatedAt: now, workingMode: 'monitoring' })

    const restored = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, restoredUnconfirmed: true as const }]
    })
    expect(restored.size).toBe(0)
  })
})
