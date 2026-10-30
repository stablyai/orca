import { expect, it } from 'vitest'
import { antigravitySignInCallback } from './antigravity-sign-in-callback'

const pending = { redirectUri: 'http://127.0.0.1:51234/', state: 'owned-state' }
const back = 'http://127.0.0.1:51234/?state=owned-state'

it("passes on only Google's answer to this sign-in, saying what is wrong with anything else", () => {
  for (const answer of ['code=example-code', 'error=access_denied']) {
    const pasted = `${back}&${answer}&iss=https%3A%2F%2Faccounts.google.com`
    expect(antigravitySignInCallback(pending, pasted).toString()).toBe(pasted)
  }
  const refused: Record<string, string[]> = {
    'too long': [`${back}&code=${'x'.repeat(16_384)}`],
    'Paste the complete redirect URL': ['127.0.0.1:51234 code=x'],
    'does not belong to the current sign-in': [
      'https://127.0.0.1:51234/?state=owned-state&code=x',
      'http://localhost:51234/?state=owned-state&code=x',
      'http://127.0.0.1:51235/?state=owned-state&code=x',
      'http://127.0.0.1:51234/other?state=owned-state&code=x',
      'http://user:password@127.0.0.1:51234/?state=owned-state&code=x',
      `${back}&code=x#fragment`,
      'http://127.0.0.1:51234/?state=wrong-state&code=x',
      `${back}&state=owned-state&code=x`
    ],
    'must contain one Google sign-in response': [`${back}&code=x&error=access_denied`, back],
    'is not a Google sign-in response': [`${back}&code=x&iss=https%3A%2F%2Fexample.com`]
  }
  for (const [message, addresses] of Object.entries(refused)) {
    for (const pasted of addresses) {
      expect(() => antigravitySignInCallback(pending, pasted), pasted).toThrow(message)
    }
  }
})
