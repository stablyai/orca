import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { constrainSavedHistoryItem } from './codex-history-saved-constraints'

it('borrows a saved cut of a rollout command output, dropping the raw snake-case copy too', () => {
  const whole = 'line of output\n'.repeat(100_000)
  const saved: AgentJournalRenderItem = {
    itemId: 'cmd',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    shortened: true,
    body: {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'cat notes.txt' },
      state: 'completed',
      output: {
        head: whole.slice(0, 16_384),
        byteLength: 1_500_000,
        digest: '7868fe1a93d8c5a7d22bbf4ed53347c0a53bc4eece1e516484dedb91f114479f',
        truncated: true
      }
    }
  }
  const constrained = constrainSavedHistoryItem(saved, {
    type: 'commandExecution',
    id: 'cmd',
    command: 'cat notes.txt',
    status: 'completed',
    aggregated_output: whole
  })
  expect(constrained).not.toBeNull()
  expect(constrained).not.toHaveProperty('aggregated_output')
  expect(constrained).not.toHaveProperty('aggregatedOutput')
})
