import { expect, it } from 'vitest'
import { identifierShadowTerms, identifierShadowText } from './session-search-identifier-split'

it('splits a camel-case symbol into its pieces and keeps the whole', () => {
  expect(identifierShadowTerms('call resolveTerminalPath here')).toEqual([
    'resolveterminalpath',
    'resolve',
    'terminal',
    'path'
  ])
})

it('splits a path into its segments and extension', () => {
  // The whole path already tokenizes on its own; only the pieces need shadowing.
  expect(identifierShadowText('src/main/foo-bar.ts')).toBe('src main foo bar ts')
})

it('leaves ordinary prose alone', () => {
  expect(identifierShadowTerms('the quick brown fox')).toEqual([])
})

it('shadows a screaming-case constant', () => {
  expect(identifierShadowTerms('MAX_RETRIES')).toEqual(['max', 'retries'])
})

it('stops at the term limit rather than growing with the message', () => {
  const text = Array.from({ length: 50 }, (_unused, index) => `alpha_beta${index}`).join(' ')
  expect(identifierShadowTerms(text, 10)).toHaveLength(10)
})
