// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createRichMarkdownEditorScope } from './document-scope'
import { listMarkdown } from './html-list-markdown'
import { markdownToHtml } from './markdown-to-html'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { currentMarkdown } from './editor-content'
import { startEditorSurface } from './editor-surface'

/**
 * Markdown into the surface and back out of it, over a real document.
 *
 * These are the document's two halves and they are only correct together: a renderer that loses an
 * ordered list's start and a serializer that renumbers from one agree with each other and lose the
 * user's text. So each case renders, then reads the markup back, and the source it began with is
 * the assertion.
 *
 * Against real elements rather than shaped objects. The serializer reads `closest`, `children`,
 * `cloneNode` and a checkbox's `checked`, and a stand-in for those is a stand-in for the thing
 * being tested — which is how the old fixtures could describe a list no renderer would produce.
 */
function surface(markdown: string, options: { editable?: boolean } = {}) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const scope = createRichMarkdownEditorScope()
  scope.editable = options.editable ?? true
  startEditorSurface(scope)
  const editor = document.getElementById('editor')!
  editor.innerHTML = markdownToHtml(scope, markdown)
  return { scope, editor, html: editor.innerHTML }
}

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
    // What a paste leaves behind: the list carries a start and its items carry nothing, which is
    // the one case where position rather than an attribute decides the number.
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
    // `isBlockStart` admits `# ` and the list test admits `- `, but the heading reader needs text
    // after the hashes and `parseListLine` needs text after the marker, so neither consumed the
    // line and the index never moved: `markdownToHtml` looped forever on a one-line source the
    // host could hand it from any file. Bare markers are text.
    expect(markdownToHtml(createRichMarkdownEditorScope(), '# ')).toBe('<p># </p>')
    expect(markdownToHtml(createRichMarkdownEditorScope(), '- ')).toBe('<p>- </p>')
    expect(markdownToHtml(createRichMarkdownEditorScope(), '1. ')).toBe('<p>1. </p>')
    // The control, so the guard is not swallowing the readers it falls back from.
    expect(markdownToHtml(createRichMarkdownEditorScope(), '# ok')).toBe('<h1>ok</h1>')
    expect(markdownToHtml(createRichMarkdownEditorScope(), '- ok')).toBe(
      '<ul><li><p>ok</p></li></ul>'
    )
  })

  it('renders no link for a javascript: URL, which is the one scheme it filters', () => {
    // The refused token falls through to the emphasis branch, so the URL survives as inert text
    // rather than disappearing. What must not survive is an element that can be tapped.
    const { html } = surface('[tap](javascript:alert(1))')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
  })

  it('round-trips a code block that holds a fence of its own', () => {
    // The fence has to be longer than the longest run inside it, or the block ends at its content:
    // a three-backtick reader took the inner line for the close and the rest became paragraphs.
    const markdown = ['````', '```', 'nested', '```', '````'].join('\n')
    const { scope, html } = surface(markdown)

    expect(html).toContain('<pre data-language=""><code>```\nnested\n```</code></pre>')
    expect(currentMarkdown(scope)).toBe(markdown)
  })

  it('round-trips a table cell that holds a pipe, and the backslash that hid it', () => {
    // A cell's own pipe is the row separator unless a backslash claims it, and the backslash is
    // itself a cell character: escaping backslashes before pipes is what keeps the two apart.
    const markdown = ['| a \\| b | c\\\\d |', '| --- | --- |', '| 1 \\| 2 | 3 |'].join('\n')
    const { scope, html } = surface(markdown)

    expect(html).toContain('<th>a | b</th><th>c\\d</th>')
    expect(html).toContain('<td>1 | 2</td><td>3</td>')
    expect(currentMarkdown(scope)).toBe(markdown)
  })
})
