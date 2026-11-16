import { expect, it } from 'vitest'
import { compareJournalLegacyChatsWhenIdle } from './journal-sql-legacy-compares'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'

async function runWith(stopping: boolean): Promise<JournalSqlMaintenance[]> {
  const settled: JournalSqlMaintenance[] = []
  let pages = 0
  await compareJournalLegacyChatsWhenIdle(
    {
      maintain: async (operation) => {
        settled.push(operation)
        return null
      }
    },
    {
      database: async () => ({
        kind: 'legacy-compares',
        compares: pages++ === 0 ? [{ sessionId: 'huge', revision: 'r1' }] : []
      }),
      compareLegacyChat: async () => {
        throw new Error('journal SQL reader exited')
      }
    },
    async () => true,
    () => stopping,
    () => {}
  )
  return settled
}

it('absorbs a chat whose compare took its reader down instead of retrying it every launch', async () => {
  expect(await runWith(false)).toEqual([
    {
      kind: 'legacy-compare-settle',
      sessionId: 'huge',
      revision: 'r1',
      error: 'journal SQL reader exited'
    }
  ])
  expect(await runWith(true)).toEqual([])
})
