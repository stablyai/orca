import { expect, it } from 'vitest'
import { SendParams } from './send-params'

it('refuses a caller payload that claims to be a bot request', () => {
  const base = { to: 'term_1', subject: 's' }
  expect(
    SendParams.safeParse({ ...base, payload: '{"botRequest":{},"images":["/x/a.png"]}' }).success
  ).toBe(false)
  expect(SendParams.safeParse({ ...base, payload: '{"taskId":"t"}' }).success).toBe(true)
})
