import { expect, it } from 'vitest'
import { agentDisplayForkedLead, agentDisplayLabel } from './agent-row-display'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/runtime-types'

function row(fields: Partial<RuntimeWorktreeAgentRow>): RuntimeWorktreeAgentRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only these fields.
  return {
    state: 'done',
    prompt: '',
    lastAssistantMessage: 'Done reviewing',
    ...fields
  } as RuntimeWorktreeAgentRow
}

it("marks a forked chat row's leading name", () => {
  const agent = row({ conversationName: 'Annotate', conversationForked: true })
  expect(agentDisplayForkedLead(agent, agentDisplayLabel(agent, 0))).toEqual({
    name: 'Annotate',
    rest: ' · Done reviewing'
  })
})

it('leaves a row unmarked when its label does not lead with the name', () => {
  const agent = row({
    conversationName: 'Annotate',
    conversationForked: true,
    state: 'working',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only the stopping flag.
    mainAgent: { stopping: true } as RuntimeWorktreeAgentRow['mainAgent']
  })
  expect(agentDisplayForkedLead(agent, agentDisplayLabel(agent, 0))).toBeNull()
})
