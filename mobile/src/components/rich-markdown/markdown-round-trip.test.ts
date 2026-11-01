// @vitest-environment happy-dom
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorScope } from './document-scope'
import { listMarkdown } from './html-list-markdown'
import { markdownToHtml } from './markdown-to-html'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { currentMarkdown } from './editor-content'
import { startEditorSurface } from './editor-surface'

// Render then serialize real DOM and compare original source: two implementations can agree while both lose numbering.
// Real closest/children/cloneNode/checked semantics prevent fixtures inventing structures renderer never produces.
function surface(markdown: string, options: { editable?: boolean } = {}) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const scope = createRichMarkdownEditorScope(quietRichMarkdownEditorHost())
  scope.editable = options.editable ?? true
  startEditorSurface(scope)
  const editor = document.getElementById('editor')!
  editor.innerHTML = markdownToHtml(scope, markdown)
  return { scope, editor, html: editor.innerHTML }
}

// Plant nested list through paragraph.innerHTML, not editor HTML: normal parser closes p before ul and would silently flatten fixture. Assert actual nesting.
function nestedListSurface(paragraphMarkup: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const scope = createRichMarkdownEditorScope(quietRichMarkdownEditorHost())
  scope.editable = true
  startEditorSurface(scope)
  const editor = document.getElementById('editor')!
  const paragraph = document.createElement('p')
  paragraph.innerHTML = paragraphMarkup
  editor.append(paragraph)
  return { scope, editor }
}

/** The item markup WebKit wraps the paragraph's text in: a styled span and a trailing break. */
const webkitItem = (text: string) =>
  `<li><span style="font-family: var(--font-sans);">${text}</span><br></li>`

describe('the editor document, from markdown and back', () => {
  it('renders and serializes nested bullet, ordered and task lists with indentation intact', () => {
    const markdown = [
      '- Parent',
      '  1. Ordered child',
      '    - [x] Done task',
      '    - [ ] Open task',
      '- Sibling'
    ].join('\n')

    const { scope, html } = surface(markdown)

    expect(html).toContain(
      '<ul><li><p>Parent</p><ol start="1"><li value="1" data-list-number="1"><p>Ordered child</p>'
    )
    expect(html).toContain('<ul data-type="taskList">')
    expect(html).toContain('<li><p>Sibling</p></li></ul>')
    expect(currentMarkdown(scope)).toBe(markdown)
  })

  it('serializes a bullet list the engine nested inside a paragraph, as the flat shape does', () => {
    // Captured WebKit 26.4/Chromium 147 insertUnorderedList nests ul in p instead of replacing p; WebKit also adds styled text span.
    const { scope, editor } = nestedListSurface(
      `<ul>${webkitItem('alpha')}${webkitItem('beta')}</ul>`
    )

    expect(editor.querySelector('ul')?.parentElement?.tagName).toBe('P')
    const markdown = ['- alpha', '- beta'].join('\n')
    expect(currentMarkdown(scope)).toBe(markdown)
    // The flat shape the renderer produces from that same source, so the two shapes agree.
    expect(currentMarkdown(surface(markdown).scope)).toBe(markdown)
  })

  it('serializes a numbered list the engine nested inside a paragraph', () => {
    // The same capture with the Numbered list command: `<p><ol><li>...</li></ol></p>` on both.
    const { scope, editor } = nestedListSurface(
      `<ol>${webkitItem('first')}${webkitItem('second')}</ol>`
    )

    expect(editor.querySelector('ol')?.parentElement?.tagName).toBe('P')
    expect(currentMarkdown(scope)).toBe(['1. first', '2. second'].join('\n'))
  })

  it('reads a paragraph that holds a list and text around it as separate blocks', () => {
    // Captured two-return list exit leaves trailing div beside ul inside p; serialize surrounding inline text as paragraphs wherever it sits.
    const { scope, editor } = nestedListSurface(
      'before the list<ul><li>solo</li></ul><div>after the list</div>'
    )

    expect(editor.querySelector('ul')?.parentElement?.tagName).toBe('P')
    expect(currentMarkdown(scope)).toBe(
      ['before the list', '', '- solo', '', 'after the list'].join('\n')
    )
  })

  it('renders markdown entities as characters without double-escaping them', () => {
    const { html } = surface('R&D &amp; Sales and &lt;tag&gt;')

    expect(html).toContain('R&amp;D &amp; Sales and &lt;tag&gt;')
    expect(html).not.toContain('&amp;amp;')
  })

  it('preserves explicit ordered-list numbering through the round trip', () => {
    const markdown = ['3. Third step', '4. Fourth step'].join('\n')
    const { scope, html } = surface(markdown)

    expect(html).toContain('<ol start="3">')
    expect(html).toContain('data-list-number="3"')
    expect(currentMarkdown(scope)).toBe(markdown)
  })

  it('serializes ordered lists from the parent start when item metadata is missing', () => {
    // Pasted list may set ol start only; without item attribute, position determines number.
    document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
    const editor = document.getElementById('editor')!
    editor.innerHTML = '<ol start="8"><li><p>Pasted step</p></li><li><p>Inserted step</p></li></ol>'

    expect(listMarkdown(editor.firstElementChild!, 0)).toBe(
      ['8. Pasted step', '9. Inserted step'].join('\n')
    )
  })

  it('renders task checkboxes as disabled while the surface is read-only', () => {
    expect(surface('- [ ] Read-only task', { editable: false }).html).toContain(
      'type="checkbox" disabled'
    )
    expect(surface('- [ ] Editable task').html).not.toContain('disabled')
  })

  it('round-trips every block the toolbar can produce', () => {
    const markdown = [
      '# Title',
      '',
      'Body with **bold**, *italic*, ~~strike~~ and `code`.',
      '',
      '> Quoted line',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
      '[docs](https://example.com/docs)',
      '',
      '![alt](https://example.com/a.png)'
    ].join('\n')

    expect(currentMarkdown(surface(markdown).scope)).toBe(markdown)
  })

  it('makes progress on a marker with nothing after it, rather than reading it forever', () => {
    // Bare block markers pass isBlockStart but item/heading readers require text; ensure index advances as plain text instead of looping forever.
    const render = (markdown: string) =>
      runInNewContext(
        'markdownToHtml(scope, markdown)',
        {
          markdownToHtml,
          scope: createRichMarkdownEditorScope(quietRichMarkdownEditorHost()),
          markdown
        },
        { timeout: 250 }
      )
    expect(render('# ')).toBe('<p># </p>')
    expect(render('- ')).toBe('<p>- </p>')
    expect(render('1. ')).toBe('<p>1. </p>')
    // The control, so the guard is not swallowing the readers it falls back from.
    expect(render('# ok')).toBe('<h1>ok</h1>')
    expect(render('- ok')).toBe('<ul><li><p>ok</p></li></ul>')
  })

  it('renders no link for a javascript: URL, which is the one scheme it filters', () => {
    // Refused URL remains inert text via emphasis fallback; no tappable element may survive.
    const { html } = surface('[tap](javascript:alert(1))')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
  })

  it('round-trips a code block that holds a fence of its own', () => {
    // Choose closing fence longer than any inner backtick run or reader ends code at its own content.
    const markdown = ['````', '```', 'nested', '```', '````'].join('\n')
    const { scope, html } = surface(markdown)

    expect(html).toContain('<pre data-language=""><code>```\nnested\n```</code></pre>')
    expect(currentMarkdown(scope)).toBe(markdown)
  })

  it('round-trips a table cell that holds a pipe, and the backslash that hid it', () => {
    // Escape cell backslashes before pipes so literal pipe remains distinct from row separator.
    const markdown = ['| a \\| b | c\\\\d |', '| --- | --- |', '| 1 \\| 2 | 3 |'].join('\n')
    const { scope, html } = surface(markdown)

    expect(html).toContain('<th>a | b</th><th>c\\d</th>')
    expect(html).toContain('<td>1 | 2</td><td>3</td>')
    expect(currentMarkdown(scope)).toBe(markdown)
  })
})
