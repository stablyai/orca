import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPhase, AgentTransition } from '../../shared/agent-transitions'
import { TerminalAgentTurnNews, type TerminalAgentTurnNewsDeps } from './terminal-agent-turn-news'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const WT = 'repo-1::/tmp/wt'

function row(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 100,
    ...overrides
  }
}

function moved(
  from: AgentPhase,
  to: AgentPhase,
  transition: AgentTransition | null
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WT, sshHostId: null },
    from,
    to,
    at: 1,
    transition
  }
}

function news(current: { row: AgentStatusIpcPayload | null }, optIn: boolean) {
  const readHookRow = vi.fn(() => current.row)
  const deps: TerminalAgentTurnNewsDeps<string> = {
    readHookRow,
    prepare: ({ row }) => row.state,
    deliver: vi.fn(),
    setTimer: () => ({ cancel: () => {} }),
    ...(optIn ? { started: vi.fn(), stopped: vi.fn() } : {})
  }
  return { turnNews: new TerminalAgentTurnNews(deps), deps, readHookRow }
}

describe('TerminalAgentTurnNews opt-ins', () => {
  it('tells a turn start, and a turn its user stopped, only to a listener that opted in', () => {
    const current: { row: AgentStatusIpcPayload | null } = { row: row({ state: 'working' }) }
    const { turnNews, deps } = news(current, true)
    turnNews.observe(moved('rest', 'working', 'prompt-submitted'))
    expect(deps.started).toHaveBeenCalledWith({ paneKey: PANE, worktreeId: WT, row: current.row })
    current.row = row({ state: 'done', interrupted: true })
    turnNews.observe(moved('working', 'rest', null))
    expect(deps.stopped).toHaveBeenCalledWith({ paneKey: PANE, worktreeId: WT, row: current.row })
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('tells no stop for a pane that rested without a stopped turn', () => {
    const current: { row: AgentStatusIpcPayload | null } = { row: null }
    const { turnNews, deps } = news(current, true)
    turnNews.observe(moved('working', 'rest', null))
    current.row = row({ state: 'done' })
    turnNews.observe(moved('done', 'rest', null))
    expect(deps.stopped).not.toHaveBeenCalled()
  })

  it('reads no extra row for a listener that did not opt in', () => {
    const current: { row: AgentStatusIpcPayload | null } = { row: row({ state: 'working' }) }
    const { turnNews, readHookRow } = news(current, false)
    turnNews.observe(moved('rest', 'working', 'prompt-submitted'))
    current.row = row({ state: 'done', interrupted: true })
    turnNews.observe(moved('working', 'rest', null))
    expect(readHookRow).not.toHaveBeenCalled()
  })
})
