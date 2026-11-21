import { describe, expect, it } from 'vitest'
import { RunOpenCodeSessionBinding } from './run-opencode-session-binding'

const opencodeRow: {
  agentType: string
  connectionId: string | null
  providerSession: { key: string; id: string }
  receivedAt: number
} = {
  agentType: 'opencode',
  connectionId: null,
  providerSession: { key: 'session_id', id: 'ses_bound' },
  receivedAt: 2
}

function binding(rows: readonly (typeof opencodeRow)[]) {
  return new RunOpenCodeSessionBinding({
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getAgentStatusSnapshotForPane: () => rows
  })
}

describe('RunOpenCodeSessionBinding', () => {
  it('binds a local opencode session and ignores other agents', () => {
    const sessions = binding([
      {
        ...opencodeRow,
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'ses_other' }
      },
      opencodeRow
    ])
    sessions.bind('run-1', 'term-1')
    expect(sessions.promptFor('run-1')).not.toBeNull()
  })

  it('clears the old session when a rebind finds no eligible session', () => {
    let rows: readonly (typeof opencodeRow)[] = [opencodeRow]
    const sessions = new RunOpenCodeSessionBinding({
      getTerminalPaneKey: () => 'tab-1:leaf-1',
      getAgentStatusSnapshotForPane: () => rows
    })
    sessions.bind('run-1', 'term-1')
    expect(sessions.promptFor('run-1')).not.toBeNull()

    rows = [{ ...opencodeRow, connectionId: 'ssh-1' }]
    sessions.bind('run-1', 'term-2')
    expect(sessions.promptFor('run-1')).toBeNull()
  })
})
