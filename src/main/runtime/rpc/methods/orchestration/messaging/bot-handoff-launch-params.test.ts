import { expect, test } from 'vitest'
import { SendParams } from './send-params'

const handoff = {
  to: 'bot:example',
  type: 'handoff',
  chat: 'new',
  subject: 'Review the docs'
}

test('a new bot handoff keeps both launch choices after RPC parsing', () => {
  const parsed = SendParams.parse({ ...handoff, model: 'sonnet', effort: 'high' })

  expect(parsed.model).toBe('sonnet')
  expect(parsed.effort).toBe('high')
})

test('effort alone cannot turn into a handoff using defaults', () => {
  expect(SendParams.safeParse({ ...handoff, effort: 'high' }).success).toBe(false)
})

test('a paired-server handoff cannot drop a requested model and send anyway', () => {
  expect(SendParams.safeParse({ ...handoff, on: 'example-server', model: 'sonnet' }).success).toBe(
    false
  )
})

test.each([
  { on: '' },
  { item: '' },
  { on: '   ' },
  { item: '   ' },
  { onClient: '' },
  { onClient: '   ' }
])('a launch override rejects explicit empty routing selectors %j', (selector) => {
  expect(SendParams.safeParse({ ...handoff, model: 'sonnet', ...selector }).success).toBe(false)
})

test('ordinary mail still normalizes empty server and item selectors away', () => {
  const parsed = SendParams.parse({ ...handoff, on: '', item: '' })
  expect(parsed.on).toBeUndefined()
  expect(parsed.item).toBeUndefined()
})
