import { describe, expect, it } from 'vitest'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-pty-agent-sources'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const paneKey = 'worktree:tab:0'
const now = Date.now()
const retained: RuntimeAgentRowSnapshot = {
  paneKey,
  ptyId: 'pty',
  tabId: 'tab',
  worktreeId: 'worktree',
  connectionId: null,
  payload: { state: 'working', prompt: 'implement', agentType: 'codex' },
  stateStartedAt: now,
  updatedAt: now
}
const base = {
  retainedSnapshots: [retained],
  hookSnapshots: [] as AgentStatusIpcPayload[],
  structuredSummaries: [],
  mirroredWorktreeIdByTabId: new Map<string, string>(),
  connectedPtyEvidence: {
    tabIds: new Set<string>(),
    paneKeys: new Set<string>(),
    ptyIds: new Set<string>()
  }
}

describe('worktree agent source admission', () => {
  it('rejects a disconnected local terminal before row assembly', () => {
    expect(collectRuntimeWorktreeAgentSources(base).size).toBe(0)
    const connected = {
      ...base,
      connectedPtyEvidence: { ...base.connectedPtyEvidence, ptyIds: new Set(['pty']) }
    }
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.state).toBe('working')
  })

  it('keeps remote evidence and resolves mirrored workspace ownership', () => {
    const remote = { ...retained, connectionId: 'ssh-connection' }
    expect(collectRuntimeWorktreeAgentSources({ ...base, retainedSnapshots: [remote] }).size).toBe(
      1
    )
    const sources = collectRuntimeWorktreeAgentSources({
      ...base,
      mirroredWorktreeIdByTabId: new Map([['tab', 'remote-worktree']])
    })
    expect(sources.get(paneKey)?.worktreeId).toBe('remote-worktree')
  })

  it('preserves fresh monitoring enrichment on a newer retained report', () => {
    const hook: AgentStatusIpcPayload = {
      ...retained.payload,
      paneKey,
      tabId: 'tab',
      worktreeId: 'worktree',
      connectionId: null,
      stateStartedAt: now - 1,
      receivedAt: now - 1,
      workingMode: 'monitoring'
    }
    const sources = collectRuntimeWorktreeAgentSources({
      ...base,
      hookSnapshots: [hook],
      connectedPtyEvidence: { ...base.connectedPtyEvidence, ptyIds: new Set(['pty']) }
    })
    expect(sources.get(paneKey)).toMatchObject({ updatedAt: now, workingMode: 'monitoring' })
  })
})
