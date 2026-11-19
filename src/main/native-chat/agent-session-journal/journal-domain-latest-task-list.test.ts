import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('reads the newest turn’s plan from its last task-list call, never an earlier turn’s', async () => {
  const f = domainLifecycleFixture(cleanup)
  const tool = (id: string, turn: string, name: string, input: unknown) =>
    f.run({
      kind: 'item',
      identity: identity(id),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: `orca:${turn}` } },
      body: { kind: 'tool-call', name, input, state: 'completed' }
    })
  const todos = (status: string) => ({
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix it', status, activeForm: 'Fixing it' }
    ]
  })
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  expect(await reads.latestTaskList()).toBeNull()

  await tool('t1', 'turn-1', 'TodoWrite', todos('pending'))
  await tool('t2', 'turn-1', 'TodoWrite', todos('in_progress'))
  await tool('t3', 'turn-1', 'Bash', { command: 'pnpm test' })
  expect((await reads.latestTaskList())?.tasks).toEqual([
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' }
  ])

  await tool('t4', 'turn-2', 'Bash', { command: 'ls' })
  expect(await reads.latestTaskList()).toBeNull()
})
