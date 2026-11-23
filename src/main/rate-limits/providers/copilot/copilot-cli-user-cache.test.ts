import { expect, it } from 'vitest'
import { copilotAccountFromFiles, selectCopilotCliUserPayload } from './copilot-cli-user-cache'

const cache = {
  copilotUserCache: {
    free: {
      retrievedAt: '2026-11-20T07:00:00.000Z',
      response: {
        login: 'other-user',
        quota_snapshots: { premium_interactions: { entitlement: 0 } }
      }
    },
    business: {
      retrievedAt: '2026-11-20T07:27:00.000Z',
      response: {
        login: 'cli-user',
        quota_snapshots: { premium_interactions: { entitlement: 6500 } }
      }
    }
  }
}

it('selects the Copilot CLI login when gh is a different account', () => {
  expect(selectCopilotCliUserPayload(cache, 'cli-user')).toMatchObject({ login: 'cli-user' })
  expect(selectCopilotCliUserPayload(cache, 'other-user')).toMatchObject({ login: 'other-user' })
})

it('reports the CLI login without reading a token', () => {
  expect(
    copilotAccountFromFiles(
      { lastLoggedInUser: { host: 'https://github.com', login: 'cli-user' } },
      cache
    )
  ).toEqual({ signedIn: true, login: 'cli-user', planType: null })
  expect(copilotAccountFromFiles(null, null)).toEqual({
    signedIn: false,
    login: null,
    planType: null
  })
})

it('falls back to the account that has an AIC allowance', () => {
  expect(selectCopilotCliUserPayload(cache, null)).toMatchObject({ login: 'cli-user' })
  expect(selectCopilotCliUserPayload({ copilotUserCache: {} }, null)).toBeNull()
})
