import { expect, it } from 'vitest'
import { AgentJournalItemBodySchema } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
import { codexItemBody } from './codex-structured-item-translation'

it.each([
  ['read', 'read'],
  ['search', 'search'],
  ['listFiles', 'list'],
  ['unknown', 'shell']
])('preserves native command origin through the journal for %s', (action, label) => {
  const body = codexItemBody({
    type: 'commandExecution',
    id: 'current-call',
    commandActions: [{ type: action }]
  })
  expect(AgentJournalItemBodySchema.parse(body)).toMatchObject({
    kind: 'tool-call',
    callId: 'current-call',
    name: label,
    state: 'running',
    codexCommandExecution: true
  })
})

it('keeps a shell display name on an integration tool separate from native command origin', () => {
  const body = codexItemBody({ type: 'mcpToolCall', id: 'other-call', tool: 'shell' })
  const row = AgentJournalItemBodySchema.parse(body)
  expect(row).toMatchObject({ kind: 'tool-call', name: 'shell' })
  expect(row).not.toHaveProperty('codexCommandExecution')
})
