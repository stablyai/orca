import { expect, it } from 'vitest'
import { extractGrokFirstUserPromptText } from './session-scanner-grok-user-text'

it('keeps query boundaries when Unicode casing changes the prefix or body length', () => {
  expect(
    extractGrokFirstUserPromptText(
      '<user_info>İstanbul</user_info><UsEr_QuErY> Fix İ parsing. </UsEr_QuErY>context'
    )
  ).toBe('Fix İ parsing.')
})
