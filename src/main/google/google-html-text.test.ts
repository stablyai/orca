import { describe, expect, it } from 'vitest'
import { htmlToText } from './google-html-text'

describe('htmlToText', () => {
  // Outlook and Word mail carries Windows-1252 numeric references; a surrogate is not a character.
  it('reads legacy numeric references as their characters and replaces unusable ones', () => {
    expect(
      htmlToText(
        '<p>&nbsp;Outlook&#146;s &#151; dash &#x2014; &#xD800; &mdash; &amp;x&nbsp;&amp;nbsp;</p>'
      )
    ).toBe('Outlook’s — dash — � — &x &nbsp;')
  })
})
