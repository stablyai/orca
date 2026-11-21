// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from '../create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from '../document/document-markup'
import { quietRichMarkdownEditorHost } from '../document/rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

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

it('keeps separate code paragraphs in a task item through host save and reopen', () => {
  const { editorDocument, editor, messages } = surface('- [ ] First\n- [x] Next\n\nOutside')
  editor.querySelector('li > div')!.innerHTML =
    '<p><code>First</code></p><p><code>Second</code></p>'
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }))
  const markdown = '- [ ] `First`<br />`Second`\n- [x] Next\n\nOutside'

  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown }
  ])
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editor.querySelector('li > div > p')?.innerHTML).toBe(
    '<code>First</code><br><code>Second</code>'
  )
  expect(editor.querySelector(':scope > p')?.textContent).toBe('Outside')
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['<p>First<br></p><p>Second</p>', 'First<br />Second'],
  ['<p>First</p><p><br></p><p>Second</p>', 'First<br /><br />Second'],
  ['First<div>Second</div>Third', 'First<br />Second<br />Third'],
  ['<strong>First</strong> <em>Second</em>', '**First** *Second*']
])('keeps existing breaks, empty lines and inline spaces without duplication: %j', (html, text) => {
  const { editorDocument, editor } = surface('- First\n- Next')
  const item = editor.querySelector('li')!
  item.innerHTML = html
  const markdown = `- ${text}\n- Next`

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('retains nested lists and checkbox labels while serializing the owning item once', () => {
  const { editorDocument, editor } = surface('- [x] First\n  8. Child\n  9. Next\n- [ ] Last')
  const paragraph = editor.querySelector('li > div > p')!
  paragraph.insertAdjacentHTML('afterend', '<p>Second</p>')
  const markdown = '- [x] First<br />Second\n  8. Child\n  9. Next\n- [ ] Last'

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editor.querySelectorAll('li').length).toBe(4)
  expect(editor.querySelectorAll('ol li').length).toBe(2)
  expect(editor.querySelectorAll('input').length).toBe(2)
  expect(editor.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
