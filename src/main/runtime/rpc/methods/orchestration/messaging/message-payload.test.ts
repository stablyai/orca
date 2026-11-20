import { expect, it } from 'vitest'
import { withoutBotRequestClaim } from './message-payload'

it('drops a caller-claimed botRequest field, even spelled with a JSON escape', () => {
  expect(withoutBotRequestClaim('{"botRequest":{},"images":["/a.png"],"taskId":"t"}')).toBe(
    '{"images":["/a.png"],"taskId":"t"}'
  )
  expect(withoutBotRequestClaim('{"bot\\u0052equest":{},"taskId":"t"}')).toBe('{"taskId":"t"}')
  expect(withoutBotRequestClaim('{"taskId":"t"}')).toBe('{"taskId":"t"}')
})
