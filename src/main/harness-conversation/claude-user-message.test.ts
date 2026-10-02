import { expect, it } from 'vitest'
import { claudeUserMessage } from './claude-user-message'

it('preserves the delivery UUID and rejects invalid IDs before sending to Claude', () => {
  const id = '12345678-1234-4234-8234-123456789abc'
  expect(claudeUserMessage('hello', [], id)).toMatchObject({ uuid: id, type: 'user' })
  expect(claudeUserMessage('hello', []).uuid).toMatch(/^[0-9a-f-]{36}$/)
  expect(() => claudeUserMessage('hello', [], 'not-a-uuid')).toThrow()
})
