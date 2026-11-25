import { expect, it } from 'vitest'
import { chat, turn } from './codex-thread-catch-up-contract-test-fixture'

it('reuses only known completed history and invalidates outside continuation and rewind', async () => {
  const c = await chat({ now: 1_800_000_000_000 })
  expect(await c.open([turn(1)])).toBe(false)
  await c.reopen()
  expect(await c.open([turn(1)])).toBe(true)
  expect(await c.open([turn(1), turn(2)])).toBe(false)
  await c.reopen()
  expect(await c.open([turn(1), turn(2)])).toBe(true)
  expect(await c.open([turn(1)])).toBe(false)
})

it('does not certify history when its provider read fails', async () => {
  const c = await chat({ now: 1_800_000_000_000 })
  await c.open([turn(1)])
  expect(
    await c.open([], {
      connection: {
        request: async () => {
          throw new Error('read unavailable')
        }
      }
    })
  ).toBe(false)
})
