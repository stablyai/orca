import { expect, it } from 'vitest'
import { callerMailProvenance } from './message-orca-provenance'

it('drops a caller-claimed botRequest field, even spelled with a JSON escape', () => {
  const from = 'term_a'
  expect(
    callerMailProvenance({ from, payload: '{"botRequest":{},"images":["/a.png"],"taskId":"t"}' })
  ).toBe('{"images":["/a.png"],"taskId":"t"}')
  expect(callerMailProvenance({ from, payload: '{"bot\\u0052equest":{},"taskId":"t"}' })).toBe(
    '{"taskId":"t"}'
  )
  expect(callerMailProvenance({ from, payload: '{"taskId":"t"}' })).toBe('{"taskId":"t"}')
})

it("refuses a caller posing as Orca's item sender unless Orca wrote the mail", () => {
  expect(() => callerMailProvenance({ from: 'orca:items', payload: '{}' })).toThrow()
  expect(
    callerMailProvenance({ from: 'orca:items', payload: '{}', orcaAuthored: 'item-mail' })
  ).toBe('{}')
})
