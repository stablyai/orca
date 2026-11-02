import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
// Pane lookup can remint tab ids by leaf; only an unknown leaf is unresolvable.
export const UNKNOWN_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const TAB_ID = 'ask-tab'
export const WORKTREE_ID = 'wt-1'
export const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
export const PTY_ID = 'pty-ask'
export const ASK_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      header: 'Style',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})
export const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/transcripts/ac1f6b90.jsonl'
}

export function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    state: 'waiting',
    prompt: 'Tabs or spaces?',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: ASK_PROMPT,
    connectionId: null,
    receivedAt: now,
    stateStartedAt: now,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    providerSession: PROVIDER_SESSION,
    ...overrides
  }
}
