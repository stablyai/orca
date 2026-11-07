import { expect, it } from 'vitest'
import { identifierShadowTerms } from './session-search-identifier-split'

it('stops at the term limit rather than growing with the message', () => {
  const text = Array.from({ length: 50 }, (_unused, index) => `alpha_beta${index}`).join(' ')
  expect(identifierShadowTerms(text, 10)).toHaveLength(10)
})
