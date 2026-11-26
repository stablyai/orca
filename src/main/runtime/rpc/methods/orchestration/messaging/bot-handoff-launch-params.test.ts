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
