// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []
const original = '| Header | Other |\n| --- | --- |\n| First | Right |\n\nOutside'

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

function surface() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(original, 7)
  return { editorDocument, editor: document.getElementById('editor')!, messages }
}

function cellTexts(editor: HTMLElement) {
  return Array.from(editor.querySelectorAll('tr')).map((row) =>
    Array.from(row.children).map((node) => node.textContent)
  )
}

it.each([
  ['First<br>Second', 'First<br />Second'],
  ['<strong>First<br>Second</strong>', '**First<br />Second**'],
  ['<code>First</code><br><code>Second</code>', '`First`<br />`Second`']
])('keeps a cell line break in its own table row through host save: %s', (html, cell) => {
  const { editorDocument, editor, messages } = surface()
  editor.querySelector('td')!.innerHTML = html
  const live = editor.innerHTML
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
  const markdown = original.replace('| First |', `| ${cell} |`)

  expect(editor.innerHTML).toBe(live)
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown }
  ])
  editorDocument.send.setMarkdown(markdown, 8)
  expect(cellTexts(editor)).toEqual([
    ['Header', 'Other'],
    ['FirstSecond', 'Right']
  ])
  expect(editor.querySelector('td')?.innerHTML).toBe(html)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['<br>', ''],
  ['First<br>', 'First'],
  ['<strong>First<br></strong>', '**First**'],
  ['\n  First\n', 'First']
])('drops placeholder breaks and formatting newlines from a cell: %j', (html, cell) => {
  const { editorDocument, editor } = surface()
  editor.querySelector('td')!.innerHTML = html

  const markdown = editorDocument.send.currentMarkdown()
  expect(markdown).toBe(original.replace('| First |', cell ? `| ${cell} |` : '|  |'))
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editor.querySelectorAll('tr').length).toBe(2)
  expect(editor.querySelector('td')?.querySelector('br')).toBe(null)
})

it('keeps an authored run of trailing cell breaks byte-for-byte', () => {
  const { editorDocument } = surface()
  const markdown = original.replace('| First |', '| x<br /><br /> |')
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each(['<br>', '<BR />', 'a<br/>b', '<br onload="run()">'])(
  'keeps typed table markup literal: %s',
  (text) => {
    const { editorDocument, editor } = surface()
    editor.querySelector('td')!.textContent = text
    const markdown = editorDocument.send.currentMarkdown()
    editorDocument.send.setMarkdown(markdown, 8)

    expect(editor.querySelector('td')?.textContent).toBe(text)
    expect(editor.querySelector('td')?.children.length).toBe(0)
    expect(editor.querySelectorAll('tr').length).toBe(2)
    expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  }
)

it('keeps a typed break literal when the browser splits it across text nodes', () => {
  const { editorDocument, editor } = surface()
  editor.querySelector('td')!.replaceChildren(document.createTextNode('<b'), 'r>')
  const markdown = editorDocument.send.currentMarkdown()
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.querySelector('td')?.textContent).toBe('<br>')
  expect(editor.querySelector('td')?.children.length).toBe(0)
})

it('recognizes attribute-free table breaks without interpreting code or paragraph HTML', () => {
  const { editorDocument, editor } = surface()
  editorDocument.send.setMarkdown(
    '| `<br>` | &#60;br&#62; |\n| --- | --- |\n| a<BR/>b | <br onload="run()"> |\n\n<br />',
    8
  )

  expect(editor.querySelector('th code')?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('th')[1]?.textContent).toBe('<br>')
  expect(editor.querySelectorAll('td')[0]?.innerHTML).toBe('a<br>b')
  expect(editor.querySelectorAll('td')[1]?.textContent).toBe('<br onload="run()">')
  expect(editor.querySelector('[onload]')).toBe(null)
  expect(editor.lastElementChild?.textContent).toBe('<br />')
  expect(editor.lastElementChild?.children.length).toBe(0)
})
