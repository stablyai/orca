// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []
const lists = [
  ['bullet', '- First\n- Next\n\nOutside', 'li'],
  ['task', '- [ ] First\n- [x] Next\n\nOutside', 'li > div']
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
    ['<p>First</p><p>Second</p>', 'First<br />Second', 'First<br>Second'],
    [
      '<p><code>First</code></p><p><code>Second</code></p>',
      '`First`<br />`Second`',
      '<code>First</code><br><code>Second</code>'
    ]
  ])(
    `preserves ${kind} item block boundaries through host save and reopen: %s`,
    (html, text, inline) => {
      const { editorDocument, editor, messages } = surface(source)
      const body = editor.querySelector(selector)!
      body.innerHTML = html
      const live = body.outerHTML
      const contents = Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)
      const checks = Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map(
        (input) => input.checked
      )
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }))
      const markdown = source.replace('First', text)

      expect(body.outerHTML).toBe(live)
      expect(messages.filter((message) => message.type === 'change')).toEqual([
        { type: 'change', generation: 7, markdown }
      ])
      editorDocument.send.setMarkdown(markdown, 8)
      expect(editor.querySelector(selector)!.querySelector('p')!.innerHTML).toBe(inline)
      expect(Array.from(editor.querySelectorAll('li')).map((item) => item.textContent)).toEqual(
        contents
      )
      expect(
        Array.from(editor.querySelectorAll<HTMLInputElement>('input')).map((input) => input.checked)
      ).toEqual(checks)
      expect(editor.querySelector(':scope > p')?.textContent).toBe('Outside')
      expect(editorDocument.send.currentMarkdown()).toBe(markdown)
    }
  )
}

it.each([
  ['<p>First<br></p><p>Second</p>', 'First<br />Second'],
  ['<p>First</p><p><br></p><p>Second</p>', 'First<br /><br />Second'],
  ['<p>First</p>\n  <p>Second</p>', 'First<br />Second'],
  ['<p>First\n</p><p>Second</p>', 'First<br />Second'],
  ['First<div>Second</div>Third', 'First<br />Second<br />Third'],
  ['First<br><div>Second</div>', 'First<br />Second'],
  ['<strong>First</strong> <em>Second</em>', '**First** *Second*']
])('keeps existing breaks, empty lines and inline spaces without duplication: %j', (html, text) => {
  const { editorDocument, editor } = surface('- First\n- Next')
  const item = editor.querySelector('li')!
  item.innerHTML = html
  const live = item.outerHTML
  const markdown = `- ${text}\n- Next`

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  expect(item.outerHTML).toBe(live)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('retains nested lists and checkbox labels while serializing the owning item once', () => {
  const { editorDocument, editor } = surface('- [x] First\n  8. Child\n  9. Next\n- [ ] Last')
  const paragraph = editor.querySelector('li > div > p')!
  paragraph.insertAdjacentHTML('afterend', '<p>Second</p>')
  const live = editor.innerHTML
  const markdown = '- [x] First<br />Second\n  8. Child\n  9. Next\n- [ ] Last'

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  expect(editor.innerHTML).toBe(live)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(editor.querySelectorAll('li').length).toBe(4)
  expect(editor.querySelectorAll('ol li').length).toBe(2)
  expect(editor.querySelectorAll('input').length).toBe(2)
  expect(editor.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
