// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

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
  editorDocument.send.setMarkdown('> First', 7)
  return { editorDocument, editor: document.getElementById('editor')!, messages }
}

it.each([
  ['<p>First</p><p>Second</p>', '> First\n> \n> Second'],
  ['First<div>Second</div>', '> First\n> \n> Second'],
  ['<b>bold</b> text<p>second</p>', '> **bold** text\n> \n> second'],
  ['First<br>Second', '> First\n> Second'],
  [
    '<code>left</code><code>right</code><p>second</p>tail',
    '> `leftright`\n> \n> second\n> \n> tail'
  ]
])('saves native quote boundaries without changing the live DOM: %s', (html, markdown) => {
  const { editorDocument, editor, messages } = surface()
  editor.innerHTML = `<blockquote>${html}</blockquote><p>Outside</p>`
  const live = editor.innerHTML
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))

  expect(editor.innerHTML).toBe(live)
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: `${markdown}\n\nOutside` }
  ])
  editorDocument.send.setMarkdown(`${markdown}\n\nOutside`, 8)
  expect(editorDocument.send.currentMarkdown()).toBe(`${markdown}\n\nOutside`)
  expect(editor.lastElementChild?.textContent).toBe('Outside')
})

it('reopens quoted paragraphs and nested quotes as separate blocks', () => {
  const { editorDocument, editor } = surface()
  const markdown = '> Outer\n> \n> > Inner\n> > \n> > Next\n> \n> End'
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.firstElementChild?.innerHTML).toBe(
    '<p>Outer</p>\n<blockquote><p>Inner</p>\n<p>Next</p></blockquote>\n<p>End</p>'
  )
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('reopens quoted headings, rules, lists and tables through the existing block readers', () => {
  const { editorDocument, editor } = surface()
  const markdown = [
    '> ## Title',
    '> ',
    '> ---',
    '> ',
    '> 3. Third',
    '> 4. Fourth',
    '> ',
    '> | a | b |',
    '> | --- | --- |',
    '> | one | two |'
  ].join('\n')
  editorDocument.send.setMarkdown(markdown, 8)

  expect(
    Array.from(editor.querySelector('blockquote')!.children).map((node) => node.tagName)
  ).toEqual(['H2', 'HR', 'OL', 'TABLE'])
  expect(editor.querySelector('ol')?.getAttribute('start')).toBe('3')
  expect(editor.querySelector('td')?.textContent).toBe('one')
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['> - a\n>   continued', '- a<br>  continued'],
  ['> > nested\n> back', '&gt; nested<br>back']
])('keeps quoted text the block readers would restructure as written: %s', (markdown, html) => {
  const { editorDocument, editor } = surface()
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.firstElementChild?.innerHTML).toBe(`<p>${html}</p>`)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('keeps quoted code literal rather than interpreting its block markers', () => {
  const { editorDocument, editor } = surface()
  const markdown = '> ```text\n> > literal &amp;\n> # still code\n> ```'
  editorDocument.send.setMarkdown(markdown, 8)

  expect(editor.querySelector('pre code')?.textContent).toBe('> literal &amp;\n# still code')
  expect(editor.querySelectorAll('blockquote').length).toBe(1)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it('keeps task state and read-only controls inside quotes', () => {
  const { editorDocument, editor } = surface()
  const markdown = '> - [x] Done\n> - [ ] Open'
  editorDocument.send.setEditable(false)
  editorDocument.send.setMarkdown(markdown, 8)

  expect(
    Array.from(editor.querySelectorAll('input')).map((input) => ({
      checked: input.checked,
      disabled: input.disabled
    }))
  ).toEqual([
    { checked: true, disabled: true },
    { checked: false, disabled: true }
  ])
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
