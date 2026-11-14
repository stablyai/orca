import { expect, it } from 'vitest'
import { listResult } from '../structured-sessions/structured-session-ownership.test-support'
import { parseAiVaultListResult } from './session-list-result-validation'

it('preserves conversation evidence and retains rows from older and newer hosts', () => {
  const fixture = listResult()
  const [session] = fixture.sessions
  if (!session) {
    throw new Error('Conversation fixture is empty')
  }
  const result = parseAiVaultListResult({
    ...fixture,
    sessions: ['empty', 'present', 'unknown', 'future-value', undefined].map(
      (conversationContent, index) => ({
        ...session,
        id: `session-${index}`,
        sessionId: `session-${index}`,
        ...(conversationContent === undefined ? {} : { conversationContent })
      })
    )
  })
  expect(result.sessions.map((row) => row.conversationContent)).toEqual([
    'empty',
    'present',
    'unknown',
    undefined,
    undefined
  ])
})
