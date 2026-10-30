import type { createOrchestrationRpcHarness } from './rpc-test-harness'
import { expect } from 'vitest'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../../native-chat/agent-session-journal/journal-store'
import type { JournalHostDatabase } from '../../../../native-chat/agent-session-journal/journal-host-database'
import { COORD } from './worker-start-card-contract-test-fixture'

export function expectWorkerStartPopulation(input: {
  journal: AgentSessionJournal
  count: number
  connection: JournalHostDatabase['db']
  facts: { dispatchId: string; workerAddress: string; task: string; name: string }[]
  before: AgentJournalSnapshot
}): void {
  const { journal, facts, count, connection, before } = input
  const cards = journal.snapshot().items.filter(({ body }) => body.kind === 'agent-start')
  expect(cards.map(({ body }) => body)).toEqual(
    facts.map((fact) => ({
      kind: 'agent-start',
      dispatchId: fact.dispatchId,
      task: fact.task,
      worker: {
        party: {
          address: fact.workerAddress,
          terminalHandle: fact.workerAddress,
          orcaSessionId: null
        },
        name: fact.name
      }
    }))
  )
  expect(
    connection.prepare('SELECT COUNT(*) AS count FROM journal_rows WHERE session_id = ?').get(COORD)
      ?.count
  ).toBe(before.cursor.sequence + count)
}

export function expectWorkerStartSourcePlans(
  queries: readonly (readonly [string])[],
  prepareSource: ReturnType<
    ReturnType<typeof createOrchestrationRpcHarness>['setup']
  >['db']['db']['prepare']
): void {
  for (const [query] of queries.slice(0, 2)) {
    const plan = prepareSource(`EXPLAIN QUERY PLAN ${query}`)
      .all('unused')
      .map((row) => row.detail)
      .join(' | ')
    expect(plan).toMatch(/SEARCH (?:dispatch_contexts|tasks)/)
    expect(plan).not.toMatch(/SCAN/)
  }
}
