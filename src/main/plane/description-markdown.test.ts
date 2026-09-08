import { describe, expect, it } from 'vitest'
import { escapeHtmlText, planeHtmlToText, textToPlaneHtml } from './description-markdown'

describe('planeHtmlToText', () => {
  it('renders paragraphs, breaks and list items as readable text', () => {
    expect(
      planeHtmlToText('<p>One &amp; two</p><ul><li>a</li><li>b</li></ul><p>three<br />four</p>')
    ).toBe('One & two\n- a\n- b\nthree\nfour')
  })

  it('decodes named and numeric entities', () => {
    expect(planeHtmlToText('<p>&lt;tag&gt; &quot;q&quot; &#65;&nbsp;B</p>')).toBe('<tag> "q" A B')
  })

  it('ignores an out-of-range numeric entity instead of throwing', () => {
    expect(planeHtmlToText('<p>a&#1114112;b</p>')).toBe('ab')
  })

  it('collapses runs of blank lines and trims', () => {
    expect(planeHtmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })

  it('is empty for empty input', () => {
    expect(planeHtmlToText(null)).toBe('')
    expect(planeHtmlToText(undefined)).toBe('')
  })
})

describe('textToPlaneHtml', () => {
  it('wraps blocks in paragraphs and single newlines in breaks', () => {
    expect(textToPlaneHtml('one\ntwo\n\nthree')).toBe('<p>one<br />two</p><p>three</p>')
  })

  it('escapes markup so ticket text cannot inject html', () => {
    expect(textToPlaneHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
    )
  })

  it('round-trips back to the original text', () => {
    expect(planeHtmlToText(textToPlaneHtml('Ada & Grace\nsecond line'))).toBe(
      'Ada & Grace\nsecond line'
    )
  })

  it('is empty for whitespace-only input', () => {
    expect(textToPlaneHtml('   \n\n  ')).toBe('')
  })
})

describe('escapeHtmlText', () => {
  it('escapes every character that could break out of an attribute or element', () => {
    expect(escapeHtmlText(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})
