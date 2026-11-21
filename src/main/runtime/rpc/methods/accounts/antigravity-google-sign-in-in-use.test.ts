import { expect, it, vi } from 'vitest'

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => null
  })
)

import { antigravityGoogleSignInInUse } from './antigravity-chat-backend'

const google = { antigravityChatAuth: { method: 'oauth-personal' as const } }

it('reads agy wherever the route sends Google-account chats to agy, installed and signed in or not', () => {
  for (const agy of ['signedIn', 'signedOut', 'unknown', 'notInstalled'] as const) {
    expect(antigravityGoogleSignInInUse(google, agy)).toBe('agy')
  }
  // Nothing saved yet is the Google account method too.
  expect(antigravityGoogleSignInInUse({}, 'notInstalled')).toBe('agy')
})

it("reads Orca's sign-in wherever they run on the server, installed or not", () => {
  expect(antigravityGoogleSignInInUse(google, false)).toBe('orca')
})

it('shows no Google choice for another sign-in method', () => {
  for (const method of ['gemini-api-key', 'agent-platform'] as const) {
    expect(antigravityGoogleSignInInUse({ antigravityChatAuth: { method } }, false)).toBeUndefined()
  }
  expect(
    antigravityGoogleSignInInUse(
      { antigravityChatAuth: { method: 'oauth-business', gcpProject: 'p', gcpLocation: 'l' } },
      false
    )
  ).toBeUndefined()
})
