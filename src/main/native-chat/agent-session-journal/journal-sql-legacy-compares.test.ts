import { expect, it } from 'vitest'
import { compareJournalLegacyChatsWhenIdle } from './journal-sql-legacy-compares'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'

async function runWith(failures: Error[], stopping = false): Promise<JournalSqlMaintenance[]> {
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
        const failure = failures.shift()
        if (failure) {
          throw failure
        }
        return { revision: 'r1', held: true }
      }
    },
    async () => true,
    () => stopping,
    () => {}
  )
  return settled
}

const exited = () => new Error('journal SQL reader exited')

it('absorbs a chat whose compare took its reader down twice instead of retrying it every launch', async () => {
  expect(await runWith([exited(), exited()])).toEqual([
    {
      kind: 'legacy-compare-settle',
      sessionId: 'huge',
      revision: 'r1',
      error: 'journal SQL reader exited'
    }
  ])
  expect(await runWith([exited()])).toEqual([
    { kind: 'legacy-compare-settle', sessionId: 'huge', revision: 'r1', held: true }
  ])
  expect(await runWith([exited()], true)).toEqual([])
})

it("leaves only the damaged chat's compare pending when this file's storage is damaged", async () => {
  const corrupt = Object.assign(new Error('database disk image is malformed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11
  })
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
        compares:
          pages++ === 0
            ? [
                { sessionId: 'damaged', revision: 'r1' },
                { sessionId: 'healthy', revision: 'r1' }
              ]
            : []
      }),
      compareLegacyChat: async (sessionId) => {
        if (sessionId === 'damaged') {
          throw corrupt
        }
        return { revision: 'r1', held: true }
      }
    },
    async () => true,
    () => false,
    () => {}
  )
  expect(settled).toEqual([
    { kind: 'legacy-compare-settle', sessionId: 'healthy', revision: 'r1', held: true }
  ])
})
