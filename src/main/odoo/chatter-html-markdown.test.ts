import { describe, expect, it } from 'vitest'
import { chatterHtmlToMarkdown, markdownToChatterHtml } from './chatter-html-markdown'

describe('chatterHtmlToMarkdown', () => {
  it("converts the tag set Odoo's editor emits", () => {
    expect(chatterHtmlToMarkdown('<p>Bonjour <b>depuis</b> Orca</p>')).toBe(
      'Bonjour **depuis** Orca'
    )
    expect(chatterHtmlToMarkdown('<p>Voir <a href="https://odoo.com">le site</a></p>')).toBe(
      'Voir [le site](https://odoo.com)'
    )
    expect(chatterHtmlToMarkdown('<h2>Titre</h2><p>Corps</p>')).toBe('## Titre\n\nCorps')
  })

  it('numbers ordered lists and keeps unordered markers', () => {
    expect(chatterHtmlToMarkdown('<ol><li>un</li><li>deux</li></ol>')).toBe('1. un\n2. deux')
    expect(chatterHtmlToMarkdown('<ul><li>un</li><li>deux</li></ul>')).toBe('- un\n- deux')
  })

  it('decodes entities, including the accents Odoo escapes', () => {
    expect(chatterHtmlToMarkdown('<p>Cr&eacute;&eacute; &amp; test&hellip;</p>')).toBe(
      'Créé & test…'
    )
    expect(chatterHtmlToMarkdown('<p>&#233;t&#xe9;</p>')).toBe('été')
  })

  it('drops script and style bodies rather than emitting their source', () => {
    expect(chatterHtmlToMarkdown('<p>ok</p><script>alert(1)</script>')).toBe('ok')
  })

  it('escapes markdown markers so chatter text cannot restructure the render', () => {
    expect(chatterHtmlToMarkdown('<p>a * b _c_ [d]</p>')).toBe('a \\* b \\_c\\_ \\[d\\]')
  })

  it('returns empty string for empty input', () => {
    expect(chatterHtmlToMarkdown('')).toBe('')
  })

  it('renders a table with a <thead> as a GFM table', () => {
    const html =
      '<table><thead><tr><th>Titre</th><th>Heures</th></tr></thead>' +
      '<tbody><tr><td>RG_01</td><td>1,5h</td></tr>' +
      '<tr><td>RG_02</td><td>0,5h</td></tr></tbody></table>'
    expect(chatterHtmlToMarkdown(html)).toBe(
      '| Titre | Heures |\n| --- | --- |\n| RG\\_01 | 1,5h |\n| RG\\_02 | 0,5h |'
    )
  })

  it('flattens multi-line cells and escapes pipes', () => {
    const html =
      '<table><tr><th>Tests</th></tr>' +
      '<tr><td>TU_02<br>TU_03</td></tr><tr><td>a | b</td></tr></table>'
    expect(chatterHtmlToMarkdown(html)).toBe('| Tests |\n| --- |\n| TU\\_02 TU\\_03 |\n| a \\| b |')
  })
})

describe('markdownToChatterHtml', () => {
  // Why: Odoo's message_post escapes plain strings, so a body that is not real
  // HTML renders with visible tags in the chatter.
  it('produces HTML Odoo can store with body_is_html', () => {
    expect(markdownToChatterHtml('Bonjour **depuis** Orca')).toBe(
      '<p>Bonjour <strong>depuis</strong> Orca</p>'
    )
  })

  it('round-trips bold text back to markdown', () => {
    expect(chatterHtmlToMarkdown(markdownToChatterHtml('Bonjour **depuis** Orca'))).toBe(
      'Bonjour **depuis** Orca'
    )
  })

  it('returns empty string for blank input', () => {
    expect(markdownToChatterHtml('   ')).toBe('')
  })

  it('passes an Odoo mention anchor embedded in markdown through untouched', () => {
    const mentionHtml =
      '<a href="#" data-oe-model="res.partner" data-oe-id="42" class="o_mail_redirect">@Nom</a>'
    const markdown = `Hey ${mentionHtml} can you check this?`
    expect(markdownToChatterHtml(markdown)).toBe(`<p>Hey ${mentionHtml} can you check this?</p>`)
  })
})

describe('mention link round-trip', () => {
  it('reads back as readable text instead of a raw "#" link', () => {
    const mentionHtml =
      '<a href="#" data-oe-model="res.partner" data-oe-id="42" class="o_mail_redirect">@Nom</a>'
    const markdown = `Hey ${mentionHtml} can you check this?`
    const storedHtml = markdownToChatterHtml(markdown)
    expect(chatterHtmlToMarkdown(storedHtml)).toBe('Hey @Nom can you check this?')
  })

  it('still renders an ordinary link with its href, unaffected by the mention special-case', () => {
    expect(chatterHtmlToMarkdown('<p>Voir <a href="https://odoo.com">le site</a></p>')).toBe(
      'Voir [le site](https://odoo.com)'
    )
  })
})

describe('attribute matching', () => {
  it('reads the real href, not a `data-*` attribute that ends in the same name', () => {
    // Odoo's editor emits data-orig-href on pasted links; without a left
    // boundary the first regex hit in the tag was the prefixed attribute.
    expect(
      chatterHtmlToMarkdown(
        '<p><a data-orig-href="https://tracker.example/redirect" href="https://odoo.com">le site</a></p>'
      )
    ).toBe('[le site](https://odoo.com)')
  })

  it('does not treat a `data-class` attribute as the mention marker class', () => {
    expect(
      chatterHtmlToMarkdown(
        '<p><a data-class="o_mail_redirect" data-oe-model="res.partner" href="https://odoo.com">Nom</a></p>'
      )
    ).toBe('[Nom](https://odoo.com)')
  })

  it('still reads an attribute that opens the tag', () => {
    expect(chatterHtmlToMarkdown('<p><img src="https://odoo.com/a.png" alt="shot"></p>')).toBe(
      '![shot](https://odoo.com/a.png)'
    )
  })
})
