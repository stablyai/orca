// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []
const lists = [
  ['bullet', '- First\n- Next\n\nOutside', 'li > p'],
  ['task', '- [ ] First\n- [x] Next\n\nOutside', 'li > div > p']
] as const

function surface(source: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(source, 7)
  return { editorDocument, editor: document.getElementById('editor')!, messages }
}

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

for (const [kind, source, selector] of lists) {
  it.each([
    ['First<br>Second', 'First<br />Second'],
    ['<strong>First<br>Second</strong>', '**First<br />Second**'],
    ['<code>First</code><br><code>Second</code>', '`First`<br />`Second`']
  ])(`keeps ${kind} item soft break inside its list through host save: %s`, (html, text) => {
    const { editorDocument, editor, messages } = surface(source)
    editor.querySelector(selector)!.innerHTML = html
    const live = editor.querySelector(selector)!.outerHTML
    const items = Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)
    const checkboxes = Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map(
      (input) => input.checked
    )
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
    const markdown = source.replace('First', text)

    expect(editor.querySelector(selector)!.outerHTML).toBe(live)
    expect(messages.filter((message) => message.type === 'change')).toEqual([
      { type: 'change', generation: 7, markdown }
    ])
    editorDocument.send.setMarkdown(markdown, 8)
    expect(Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)).toEqual(items)
    expect(
      Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map((input) => input.checked)
    ).toEqual(checkboxes)
    expect(editor.querySelector(selector)?.innerHTML).toBe(html)
    expect(editor.querySelector(':scope > p')?.textContent).toBe('Outside')
    expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  })
}

it.each([
  ['- First\n- Next', 'li > p', '<br>'],
  ['3. First\n4. Next', 'li > p', 'a<BR/>b'],
  ['- [ ] First\n- [x] Next', 'li > div > p', '<br onload="run()">']
])('keeps typed list markup literal: %s', (source, selector, text) => {
  const { editorDocument, editor } = surface(source)
  editor.querySelector(selector)!.textContent = text
  const markdown = editorDocument.send.currentMarkdown()
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.querySelector(selector)?.textContent).toBe(text)
  expect(editor.querySelector(selector)?.children.length).toBe(0)
  expect(editor.querySelectorAll('li').length).toBe(2)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('recognizes attribute-free list breaks while keeping code and paragraph markup literal', () => {
  const { editor } = surface('- `<br>`\n- &#60;br&#62;\n- a<BR/>b\n- <br onload="run()">\n\n<br />')

  expect(editor.querySelector('li code')?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('li')[1]?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('li')[2]?.querySelector('p')?.innerHTML).toBe('a<br>b')
  expect(editor.querySelectorAll('li')[3]?.textContent).toBe('<br onload="run()">')
  expect(editor.querySelector('[onload]')).toBe(null)
  expect(editor.lastElementChild?.textContent).toBe('<br />')
  expect(editor.lastElementChild?.children.length).toBe(0)
})

it.each([
  ['- First\n- Next\n- Last', 'li > p'],
  ['- [ ] First\n- [x] Next\n- [ ] Last', 'li > div > p']
])('keeps a cleared item in its list instead of writing a bare marker: %s', (source, selector) => {
  const { editorDocument, editor } = surface(source)
  editor.querySelectorAll(selector)[1]!.replaceChildren(document.createElement('br'))
  const markdown = editorDocument.send.currentMarkdown()
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.children.length).toBe(1)
  expect(Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
    'First',
    '',
    'Last'
  ])
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['<span>First</span><br>', 'First'],
  ['<p>First<br></p>', 'First'],
  ['<p><strong>First<br></strong></p>', '**First**'],
  ['<span>First</span><br><ul><li><p>Child</p></li></ul>', 'First\n  - Child'],
  ['<p>First<br><br></p>', 'First<br /><br />'],
  ['<p><br>First</p>', '<br />First'],
  ['<p>\n  First\n</p>', 'First']
])('drops only the caret placeholder break from an item: %j', (html, text) => {
  const { editorDocument, editor } = surface('- First\n- Next\n\nOutside')
  const item = editor.querySelector('li')!
  item.innerHTML = html
  const live = item.outerHTML
  const markdown = `- ${text}\n- Next\n\nOutside`

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  expect(item.outerHTML).toBe(live)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
