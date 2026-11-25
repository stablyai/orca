import { expect, it } from 'vitest'
import { agyLoginAnswer, agyLoginLink } from './antigravity-sign-in-url'

// Printed by `agy acp --login` 1.5.16.
const AGY_LINK =
  'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=wcxbvaUuh8HzigoWZAjA7uiR7CqrX2PYA-8r287yFmQ&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+openid&state=hR52ZskqjDXsjURm0G6eFw'

it("opens only Google's own sign-in link back to agy's callback page", () => {
  expect(agyLoginLink(`  ${AGY_LINK}`)).toBe(AGY_LINK)
  expect(agyLoginLink('Open this link in a browser to log in with Google:')).toBeNull()
  expect(
    agyLoginLink(AGY_LINK.replace('accounts.google.com', 'accounts.google.com.evil.test'))
  ).toBeNull()
  expect(
    agyLoginLink(AGY_LINK.replace('antigravity.google%2Foauth-callback', 'evil.test%2Fcb'))
  ).toBeNull()
})

it('writes agy one line: a code, or the callback address that carries one', () => {
  expect(agyLoginAnswer(' 4/0Abc-def_123 ')).toBe('4/0Abc-def_123')
  expect(agyLoginAnswer('https://antigravity.google/oauth-callback?code=c&state=s')).toBe(
    'https://antigravity.google/oauth-callback?code=c&state=s'
  )
  expect(agyLoginAnswer('code\nsecond line')).toBeNull()
  expect(agyLoginAnswer('https://evil.test/oauth-callback?code=c')).toBeNull()
  expect(agyLoginAnswer('two words')).toBeNull()
})
