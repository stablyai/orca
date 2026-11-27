import { expect, it } from 'vitest'
import { extractHtmlTitle } from './html-head-tags'

it('uses HTML numeric character-reference replacements in page titles', () => {
  expect(
    extractHtmlTitle('<title>&#128; &#x93;quoted&#x94; &#0; &#xD800; &#x110000; &#x1F600;</title>')
  ).toBe('€ “quoted” � � � 😀')
})
