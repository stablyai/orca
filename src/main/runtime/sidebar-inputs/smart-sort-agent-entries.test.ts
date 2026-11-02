import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { SmartSortAgentEntries } from './smart-sort-agent-entries'

const WT = 'repo-1::/tmp/a'
const PANE = makePaneKey('tab-1', '33333333-3333-4333-8333-333333333333')

function status(server: AgentHookServer, state: 'working' | 'waiting' | 'done'): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: WT,
    payload: { state, prompt: 'task', agentType: 'codex' }
  })
}

describe('SmartSortAgentEntries', () => {
  it('keeps one entry per pane and records each state switch into its history', () => {
    const server = new AgentHookServer()
    const entries = new SmartSortAgentEntries()
    const onChange = vi.fn()
    const detach = entries.attach(server, onChange)

    status(server, 'working')
    status(server, 'waiting')
    status(server, 'working')
    const entry = entries.byPaneKey()[PANE]
    expect(entry).toMatchObject({ state: 'working', worktreeId: WT, tabId: 'tab-1' })
    expect(entry?.stateHistory.map((h) => h.state)).toEqual(['working', 'waiting'])
    expect(onChange).toHaveBeenCalled()

    detach()
    expect(entries.byPaneKey()).toEqual({})
  })

  it('seeds from rows the store already holds', () => {
    const server = new AgentHookServer()
    status(server, 'waiting')
    const entries = new SmartSortAgentEntries()
    entries.attach(server, () => {})
    expect(entries.byPaneKey()[PANE]?.state).toBe('waiting')
  })
})
