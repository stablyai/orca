import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { resolveJournalGuardedItem } from '../journal-timeline-resolution'

const identity = {
  provider: 'legacy',
  agent: 'opencode',
  sessionId: 's',
  recordId: 'tool:c1'
} as const
const saved: AgentJournalToolCallItem = {
  kind: 'tool-call',
  callId: 'c1',
  name: 'task',
  input: { prompt: 'review the diff' },
  state: 'running'
}
const view = {
  item: () => ({ itemId: 'i', revision: 1, body: saved, sequence: 1, observedAt: 0 }),
  itemBody: () => null
}

describe('a call update whose start a cut replay lost', () => {
  it('settles the saved row and keeps its name and input', () => {
    const bare: AgentJournalToolCallItem = {
      kind: 'tool-call',
      callId: 'c1',
      name: 'tool',
      input: null,
      state: 'completed'
    }
    const resolution = { kind: 'guarded-item', identity, body: bare, change: 'close' } as const
    const thread = { kind: 'thread' } as const
    expect(
      resolveJournalGuardedItem(view, { ...resolution, keepsSavedCall: true }, thread)
    ).toEqual({ kind: 'resolved', item: { identity, body: { ...saved, state: 'completed' } } })
    // Without the mark the update's own fields stand, as for any provider.
    expect(resolveJournalGuardedItem(view, resolution, thread)).toEqual({
      kind: 'resolved',
      item: { identity, body: bare }
    })
  })
})
