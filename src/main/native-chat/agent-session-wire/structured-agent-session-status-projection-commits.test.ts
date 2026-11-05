import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

const journals = createTrackedJournalOpener()
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-projection-commits-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('reuses status for creation cards but reprojects an existing item replaced by a card', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: 'status-commits',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root
  })
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const answer = { provider: 'orca' as const, clientMessageId: 'answer' }
  await journal.appendItem(
    answer,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Saved answer' }]
    },
    options
  )
  const projections = new StructuredAgentSessionJournalProjections()
  const previous = projections.read(journal, null).state
  journal.observeCommits((rows) => projections.advance(journal, rows))
  const statusReads = vi.spyOn(journal, 'statusRead')
  for (let index = 0; index < 10; index++) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `card-${index}` },
      {
        kind: 'agent-start',
        dispatchId: `dispatch-${index}`,
        task: 'Task',
        worker: {
          party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
          name: 'Worker'
        }
      },
      options
    )
    expect(projections.read(journal, null).state).toEqual(previous)
  }
  expect(statusReads).not.toHaveBeenCalled()
  expect(projections.read(journal, null).sequence).toBe(journal.cursor().sequence)
  await journal.appendItem(
    answer,
    {
      kind: 'agent-start',
      dispatchId: 'replacement',
      task: 'Task',
      worker: {
        party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
        name: 'Worker'
      }
    },
    options
  )
  const replaced = projections.read(journal, null)
  expect(statusReads).toHaveBeenCalledTimes(1)
  expect(replaced.state.summary.lastAssistantMessage).toBeUndefined()
  expect(replaced.state).toEqual(
    new StructuredAgentSessionJournalProjections().read(journal, null).state
  )
})

it('does not advance across an unobserved relevant commit', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: 'status-gap',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root
  })
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const projections = new StructuredAgentSessionJournalProjections()
  projections.read(journal, null)
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'answer' },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Unobserved answer' }]
    },
    options
  )
  journal.observeCommits((rows) => projections.advance(journal, rows))
  const statusReads = vi.spyOn(journal, 'statusRead')
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'card' },
    {
      kind: 'agent-start',
      dispatchId: 'dispatch',
      task: 'Task',
      worker: {
        party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
        name: 'Worker'
      }
    },
    options
  )
  const projected = projections.read(journal, null)
  expect(statusReads).toHaveBeenCalledTimes(1)
  expect(projected.state.summary.lastAssistantMessage).toBe('Unobserved answer')
  expect(projected.state).toEqual(
    new StructuredAgentSessionJournalProjections().read(journal, null).state
  )
})
