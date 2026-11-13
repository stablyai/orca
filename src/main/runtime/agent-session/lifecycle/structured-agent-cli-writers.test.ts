import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { assertCliConversationWritersExited } from './structured-agent-cli-writers'

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'claude',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
const conflict = {
  refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
}

describe('canonical status store conversation admission', () => {
  // The source terminal's own agent stops with the close that follows, so it is no other writer.
  it('leaves out the panes the caller closes, by key or by their PTY, unless a shared server holds it', async () => {
    const ptys: Record<string, string> = { 'tab-1:leaf': 'pty-1', 'legacy-1': 'pty-1' }
    const admit = (
      rows: AgentStatusIpcPayload[],
      topology: 'pane-owned' | 'shared' = 'pane-owned'
    ) =>
      assertCliConversationWritersExited(
        {
          rows: () => rows,
          observation: () => ({ current: () => true, presence: async () => 'live', topology }),
          ptyResolver: () => (paneKey) => ptys[paneKey] ?? null
        },
        'claude',
        'conversation',
        ['tab-1:leaf']
      )
    await expect(admit([{ ...row, paneKey: 'tab-1:leaf' }])).resolves.toBeUndefined()
    await expect(admit([{ ...row, paneKey: 'legacy-1' }])).resolves.toBeUndefined()
    await expect(admit([{ ...row, paneKey: 'tab-2:leaf' }])).rejects.toMatchObject(conflict)
    await expect(admit([{ ...row, paneKey: 'tab-1:leaf' }], 'shared')).rejects.toMatchObject(
      conflict
    )
  })

  // Many terminals can name one conversation: a check starts only a few probes at once, and none
  // once a holder refused.

  // Every create, resume and acquire runs this check: resolving panes for nothing to leave out, or
  // scanning every terminal for each row, would grow with rows times terminals.
})
